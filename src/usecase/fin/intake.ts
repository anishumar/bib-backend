// FinCompliance intake (docs/FIN_BUILD_PLAN.md F2.1): the sweep that takes in
// the files clients supply and sends each one to a reader.
//
// It runs in the fin job (`cmd/fin-once.ts`), never in the API or the core
// worker. It reads files; it never changes one, never moves a task and never
// writes anything a client can see.
//
// ── AT-LEAST-ONCE, LIKE EVERYTHING THE ENGINE TOUCHES ─────────────────────
//
// Two runs can overlap and a run can die halfway. Neither may take a file in
// twice: the row is written by an insert that conflicts on
// `intake_item_once`, and the event is written only for rows actually created.
// A file left untaken by a crash is simply the oldest candidate next run.
//
// ── ONE FIRM'S BAD DATA NEVER STOPS THE OTHERS ────────────────────────────
//
// T3.1's lesson, kept by every sweep in this product: a firm the sweep fails on
// is reported and the loop moves on.
import type { IdGen } from "../../platform/ids";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import { DOCUMENT_KINDS } from "../../domain/filestore/model";
import { routeFor, takenKinds } from "../../domain/fin/intake";
import { FinNotEnabled } from "../../domain/fin/errors";
import type { EventSink } from "../ledger/ports";
import type {
  FinFirms,
  IntakeCandidateSource,
  IntakeItemView,
  IntakeRepository,
} from "./ports";

/** How many files one run takes in per firm. A month-end batch larger than
 *  this is finished on the next runs; `more` says so. */
export const INTAKE_BATCH = 200;

export interface IntakeSweepReport {
  readonly tenantId: string;
  /** Files taken in on this run. */
  readonly taken: number;
  /** Of those, how many went to a person because no reader fits. */
  readonly manual: number;
  /** Candidates another run had already taken in between the read and the
   *  insert. Printed because it is the number that shows idempotency working. */
  readonly alreadyTaken: number;
  /** The batch was full, so more files are waiting for the next run. */
  readonly more: boolean;
  readonly failure?: string;
}

export interface Deps {
  readonly firms: FinFirms;
  readonly candidates: IntakeCandidateSource;
  readonly items: IntakeRepository;
  readonly events: EventSink;
  readonly ids: IdGen;
  readonly batchSize?: number;
}

export class FinIntakeService {
  constructor(private readonly deps: Deps) {}

  async sweep(): Promise<readonly IntakeSweepReport[]> {
    const reports: IntakeSweepReport[] = [];
    for (const tenantId of await this.deps.firms.enabledFirmIds()) {
      try {
        reports.push(await this.sweepFirm(tenantId));
      } catch (err) {
        reports.push({
          tenantId,
          taken: 0,
          manual: 0,
          alreadyTaken: 0,
          more: false,
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }

  async sweepFirm(tenantId: string): Promise<IntakeSweepReport> {
    const limit = this.deps.batchSize ?? INTAKE_BATCH;
    const candidates = await this.deps.candidates.untaken(
      tenantId,
      takenKinds(DOCUMENT_KINDS),
      limit,
    );

    let taken = 0;
    let manual = 0;
    let alreadyTaken = 0;
    for (const c of candidates) {
      const decision = routeFor(c.mediaType, c.filename);
      const id = this.deps.ids.newId();
      const created = await this.deps.items.insert({
        id,
        tenantId,
        documentVersionId: c.documentVersionId,
        clientPartyId: c.clientPartyId,
        mediaType: c.mediaType,
        byteSize: c.byteSize,
        route: decision.route,
        routeBasis: decision.basis,
      });
      if (!created) {
        alreadyTaken += 1;
        continue;
      }
      taken += 1;
      if (decision.route === "manual") manual += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "fin.intake_routed",
        objectId: id,
        actor: SYSTEM_ACTOR,
        payload: {
          documentVersionId: c.documentVersionId,
          route: decision.route,
          routeBasis: decision.basis,
          mediaType: c.mediaType,
          byteSize: c.byteSize,
        },
      });
    }
    return { tenantId, taken, manual, alreadyTaken, more: candidates.length >= limit };
  }

  /** The files fin has taken in for this firm, newest first. */
  async recent(tenantId: string, limit: number): Promise<readonly IntakeItemView[]> {
    if (!(await this.deps.firms.isEnabled(tenantId))) throw new FinNotEnabled();
    return this.deps.items.recent(tenantId, limit);
  }
}
