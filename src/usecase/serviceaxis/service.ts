// The service-axis use case — the firm's own Depts and delivery teams, and its
// choice of which one (if either) splits a client's work. No I/O, no SQL, no
// HTTP: everything outside arrives as an injected port, so this reads as a
// description of what the business does and is testable with in-memory fakes.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  ServiceAxis,
  ServiceAxisKind,
  WorkSplitAxis,
} from "../../domain/serviceaxis/model";
import {
  WORK_SPLIT_AXES,
  assignableAxes,
  axisOrder,
  isValidAxisCode,
  isValidAxisName,
  isWorkSplitAxis,
  normalizeAxisCode,
} from "../../domain/serviceaxis/model";
import {
  AxisCodeTaken,
  AxisNotFound,
  InvalidAxisCode,
  InvalidAxisName,
  InvalidWorkSplitAxis,
  WorkSplitAxisEmpty,
} from "../../domain/serviceaxis/errors";
import type { NewServiceAxis, ServiceAxisRepository, WorkSplitSetting } from "./ports";

export interface Deps {
  readonly axes: ServiceAxisRepository;
  readonly split: WorkSplitSetting;
  readonly ids: IdGen;
  readonly events: EventSink;
}

export interface CreateAxisInput {
  readonly tenantId: string;
  readonly axis: ServiceAxisKind;
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface UpdateAxisInput {
  readonly tenantId: string;
  readonly id: string;
  /** Absent means unchanged, for each independently. */
  readonly name?: string | undefined;
  readonly sortOrder?: number | undefined;
}

export interface SetAxisActiveInput {
  readonly tenantId: string;
  readonly id: string;
  readonly isActive: boolean;
}

export interface SetWorkSplitInput {
  readonly tenantId: string;
  readonly axis: string;
}

export class ServiceAxisService {
  constructor(private readonly deps: Deps) {}

  /** One list in the firm's own order, retired rows included. */
  async listAxis(tenantId: string, axis: ServiceAxisKind): Promise<readonly ServiceAxis[]> {
    return axisOrder(await this.deps.axes.list(tenantId, axis));
  }

  /** Both lists, ordered, in one round trip — what a screen with two pickers
   *  needs, and what the config write path checks a service body against. */
  async listAll(tenantId: string): Promise<readonly ServiceAxis[]> {
    return axisOrder(await this.deps.axes.listAll(tenantId));
  }

  async getAxis(tenantId: string, id: string): Promise<ServiceAxis> {
    const row = await this.deps.axes.findById(tenantId, id);
    if (!row) throw new AxisNotFound(id);
    return row;
  }

  /** How this firm cuts a client's work up. `none` until it says otherwise. */
  async getWorkSplit(tenantId: string): Promise<WorkSplitAxis> {
    return this.deps.split.read(tenantId);
  }

  /**
   * Add a Dept or a delivery team.
   *
   * The code is normalised first and then checked, so the firm cannot end up
   * with `FRC` and `frc` as two Depts — which is the whole reason these are rows
   * and not a text box.
   */
  async createAxis(input: CreateAxisInput, actor: Actor): Promise<ServiceAxis> {
    const code = normalizeAxisCode(input.code);
    if (!isValidAxisCode(code)) throw new InvalidAxisCode(input.code);
    if (!isValidAxisName(input.name)) throw new InvalidAxisName(input.name);

    // Checked rather than left to the unique constraint, which would surface as
    // an unexplained 500 on a screen where the fix is obvious.
    const existing = await this.deps.axes.findByCode(input.tenantId, input.axis, code);
    if (existing) throw new AxisCodeTaken(input.axis, code);

    const row = await this.deps.axes.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      axis: input.axis,
      code,
      name: input.name.trim(),
      sortOrder: input.sortOrder,
    } satisfies NewServiceAxis);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "service_axis.created",
      objectId: row.id,
      actor,
      payload: { axis: row.axis, code: row.code },
    });
    return row;
  }

  /** Rename a Dept or reorder it. The CODE is not changeable — see the patch
   *  type; every published service body joins on it. */
  async updateAxis(input: UpdateAxisInput, actor: Actor): Promise<ServiceAxis> {
    const before = await this.getAxis(input.tenantId, input.id);
    if (input.name !== undefined && !isValidAxisName(input.name)) {
      throw new InvalidAxisName(input.name);
    }

    const row = await this.deps.axes.update(input.tenantId, input.id, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "service_axis.updated",
      objectId: row.id,
      actor,
      // The code, not the names: the ledger holds no PII and a display name is
      // the firm's own words, but the code is what a reader needs to know WHICH
      // row moved. `renamed` records that the label changed without repeating it.
      payload: {
        axis: row.axis,
        code: row.code,
        renamed: before.name !== row.name,
        reordered: before.sortOrder !== row.sortOrder,
      },
    });
    return row;
  }

  /**
   * Retire a Dept or team, or bring it back.
   *
   * Retiring one that the firm currently SPLITS WORK BY is allowed, and
   * deliberately: it is how a firm restructures, one row at a time. What is
   * refused is arriving at a state where the chosen axis has nothing active on
   * it — see `setWorkSplit`, which makes the same check from the other side.
   */
  async setAxisActive(input: SetAxisActiveInput, actor: Actor): Promise<ServiceAxis> {
    const before = await this.getAxis(input.tenantId, input.id);
    if (before.isActive === input.isActive) return before;

    if (!input.isActive) await this.refuseEmptyingTheChosenAxis(input.tenantId, before);

    const row = await this.deps.axes.setActive(input.tenantId, input.id, input.isActive);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: input.isActive ? "service_axis.reactivated" : "service_axis.retired",
      objectId: row.id,
      actor,
      payload: { axis: row.axis, code: row.code },
    });
    return row;
  }

  /**
   * Choose how this firm cuts a client's work up.
   *
   * Refused when the chosen list has nothing active on it, because that setting
   * would take effect and do nothing: every job would land in the same unfiled
   * bucket, which is what `none` already does. A setting that appears to work
   * and does not is the outcome this whole task exists to prevent.
   */
  async setWorkSplit(input: SetWorkSplitInput, actor: Actor): Promise<WorkSplitAxis> {
    if (!isWorkSplitAxis(input.axis)) {
      throw new InvalidWorkSplitAxis(input.axis, WORK_SPLIT_AXES);
    }
    if (input.axis !== "none") {
      const rows = await this.deps.axes.list(input.tenantId, input.axis);
      if (assignableAxes(rows).length === 0) throw new WorkSplitAxisEmpty(input.axis);
    }

    const before = await this.deps.split.read(input.tenantId);
    if (before === input.axis) return before;

    await this.deps.split.write(input.tenantId, input.axis);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "work_split_axis.changed",
      objectId: input.tenantId,
      actor,
      // Both halves. "What did it used to be" is the question asked when a job
      // looks split the wrong way, and an event holding only the new value
      // cannot answer it.
      payload: { from: before, to: input.axis },
    });
    return input.axis;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Refuse retiring the LAST active row on the axis the firm splits work by.
   *  The mirror of `setWorkSplit`'s check: both roads to the same broken state
   *  are closed, because closing only one leaves the other open. */
  private async refuseEmptyingTheChosenAxis(
    tenantId: string,
    row: ServiceAxis,
  ): Promise<void> {
    const chosen = await this.deps.split.read(tenantId);
    if (chosen !== row.axis) return;
    const rows = await this.deps.axes.list(tenantId, row.axis);
    const remaining = assignableAxes(rows).filter((r) => r.id !== row.id);
    if (remaining.length === 0) throw new WorkSplitAxisEmpty(row.axis);
  }
}
