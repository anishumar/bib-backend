// In-memory port fakes for the firm's Depts and delivery teams (G2.4).
// `implements` both ports the Postgres adapter carries, so a compile error here
// is the same compile error production would get.
import type { ServiceAxis, ServiceAxisKind, WorkSplitAxis } from "../domain/serviceaxis/model";
import type {
  NewServiceAxis,
  ServiceAxisPatch,
  ServiceAxisRepository,
  WorkSplitSetting,
} from "../usecase/serviceaxis/ports";
import type { AxisDirectory, KnownAxis } from "../usecase/config/ports";

/**
 * One store behind two ports, exactly as `PostgresServiceAxisRepository` is one
 * class behind two.
 *
 * That matters for the config tests: they publish a service naming a Dept
 * through the registry's `AxisDirectory` seam, and it has to see the rows the
 * service-axis service actually wrote rather than a second, agreeing-by-luck
 * copy of them. T3.5 shipped a duplicate `TenantDirectory` fake and caught it at
 * the composition root; one store is how that is avoided rather than caught.
 */
export class FakeServiceAxisRepo implements ServiceAxisRepository, AxisDirectory {
  readonly rows: ServiceAxis[] = [];

  /** Seed a row directly, for a test that needs a firm's list to already exist
   *  without walking the service to build it. */
  seed(row: Omit<ServiceAxis, "isActive"> & { isActive?: boolean }): ServiceAxis {
    const seeded: ServiceAxis = { ...row, isActive: row.isActive ?? true };
    this.rows.push(seeded);
    return seeded;
  }

  list(tenantId: string, axis: ServiceAxisKind): Promise<readonly ServiceAxis[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId && r.axis === axis),
    );
  }

  listAll(tenantId: string): Promise<readonly ServiceAxis[]> {
    return Promise.resolve(this.rows.filter((r) => r.tenantId === tenantId));
  }

  findById(tenantId: string, id: string): Promise<ServiceAxis | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null,
    );
  }

  findByCode(
    tenantId: string,
    axis: ServiceAxisKind,
    code: string,
  ): Promise<ServiceAxis | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.axis === axis && r.code === code) ??
        null,
    );
  }

  create(row: NewServiceAxis): Promise<ServiceAxis> {
    const created: ServiceAxis = { ...row, isActive: true };
    this.rows.push(created);
    return Promise.resolve(created);
  }

  update(tenantId: string, id: string, patch: ServiceAxisPatch): Promise<ServiceAxis> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === id);
    const current = this.rows[i];
    if (i < 0 || !current) throw new Error(`service_axis ${id} not in the fake`);
    // Absent means unchanged, matching the adapter's COALESCE.
    const next: ServiceAxis = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    };
    this.rows[i] = next;
    return Promise.resolve(next);
  }

  setActive(tenantId: string, id: string, isActive: boolean): Promise<ServiceAxis> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === id);
    const current = this.rows[i];
    if (i < 0 || !current) throw new Error(`service_axis ${id} not in the fake`);
    const next: ServiceAxis = { ...current, isActive };
    this.rows[i] = next;
    return Promise.resolve(next);
  }

  // ── AxisDirectory ───────────────────────────────────────────────────────────

  knownAxes(tenantId: string): Promise<readonly KnownAxis[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId)
        .map((r) => ({ axis: r.axis, code: r.code, isActive: r.isActive })),
    );
  }
}

/** The tenant's `work_split_axis` column, in memory. Defaults to `none` for a
 *  firm nobody has configured, exactly as the column's default does. */
export class FakeWorkSplitSetting implements WorkSplitSetting {
  private readonly chosen = new Map<string, WorkSplitAxis>();

  read(tenantId: string): Promise<WorkSplitAxis> {
    return Promise.resolve(this.chosen.get(tenantId) ?? "none");
  }

  write(tenantId: string, axis: WorkSplitAxis): Promise<void> {
    this.chosen.set(tenantId, axis);
    return Promise.resolve();
  }
}

/**
 * An `AxisDirectory` for a firm that has defined NO lists at all — which is what
 * every firm looks like until somebody opens the firm-structure screen.
 *
 * It accepts any code, and that is the registry's actual rule rather than a
 * convenience: a list the firm has not written is not a list to check against.
 * See `checkServiceAxes` for why, and for the residue it leaves.
 *
 * Used by the many existing tests that publish a service and have nothing to say
 * about Depts. A test that IS about refusing an unknown Dept uses
 * `FakeServiceAxisRepo`, which is the one that can refuse.
 */
export class NoAxesDefined implements AxisDirectory {
  knownAxes(): Promise<readonly KnownAxis[]> {
    return Promise.resolve([]);
  }
}
