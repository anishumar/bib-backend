// FinCompliance's read sweep (docs/FIN_BUILD_PLAN.md F2.5, the wave 3 contract's
// "Reading flow"): every file fin took in is offered to the readers, and what
// they make of it is stored as one read and its lines.
//
// It runs in the fin job (`cmd/fin-once.ts`), after the intake sweep. It reads
// files and writes reads; it never commits a line, never books anything and
// never writes anything a client can see. Nothing it writes counts until a
// person commits it (F2.8, ground rule 2).
//
// ── WHICH ITEMS ──────────────────────────────────────────────────────────────
//
// Intake items with no read (an anti-join on `fin.read`, at-least-once like the
// intake), whose route has at least one registered reader, plus every `manual`
// item, which becomes a `needs_person` / `no_reader` read without being opened:
// nothing can read it, and the read is what puts it on a person's desk. A route
// with no reader yet (today `pdf`, `image` and `archive`, until the PDF and AI
// readers are wired) is not touched, so those files wait unread rather than
// being parked with a person for want of code.
//
// ── EACH ITEM ────────────────────────────────────────────────────────────────
//
// The bytes are fetched once and offered to the route's readers in order. The
// first answer that is not `not_mine` decides:
//
//   read          the draft's control figures are checked (`decideRead`), and
//                 the read and its lines are written in ONE transaction:
//                 `staged`, or `needs_person` / `control_mismatch` with the
//                 lines kept so a person sees them.
//   needs_person  a read with that problem and no lines.
//   later         nothing is written; the item is offered again next run. The
//                 reader then rests for the rest of THIS run: its reasons (no
//                 key, unreachable, over budget) are about the reader, not the
//                 file, and asking it again for every item would be the same
//                 answer at the price of a fetch each time.
//   (all not_mine) `needs_person` / `no_reader`.
//
// The read's unique key makes a second run, or two at once, harmless: the
// insert conflicts and writes nothing, and the ledger event is written only for
// a read actually created.
//
// ── WHEN SOMETHING GOES WRONG ────────────────────────────────────────────────
//
// A reader that THROWS gets a `failed` read (problem `unreadable`): a reader
// handed the same bytes throws the same way, so retrying is a loop, and a
// failed read is the per-item stop, on a person's desk, with the error in the
// run's report. Anything else that fails for one item (its bytes missing from
// the store, the database refusing the write) is reported for that item and the
// item is left unread for the next run: those are faults an operator fixes, and
// once fixed the item reads. One firm's failure is reported and the loop moves
// on, as in every sweep in this product.
//
// ── NOT STARVED BY ITEMS IT LEAVES ───────────────────────────────────────────
//
// A run walks the unread items oldest first with a cursor, so items left unread
// (`later`, a fault) do not sit at the head of every page and hide the files
// behind them. It stops after `batchSize` reads, or after looking at twenty
// times that many items, and says `more`.
import type { IdGen } from "../../platform/ids";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { IntakeRoute } from "../../domain/fin/intake";
import type { DocKind, ReadDraft, ReadProblem, Reader } from "../../domain/fin/lines";
import { decideRead } from "../../domain/fin/read";
import type { ReadStatus, StoredControl } from "../../domain/fin/read";
import type { EventSink } from "../ledger/ports";
import type { FinFirms } from "./ports";
import type { DocumentReader, ReadInput, ReadOutcome } from "./reading";
import type { NewLine, ReadStore, UnreadItem, VersionBytes } from "./read-ports";

/** How many reads one run writes per firm. A month-end batch larger than this
 *  is finished on the next runs; `more` says so. */
export const READ_BATCH = 50;

/** How many items one run looks at per firm, per read it may write. Bounds a
 *  run in which most items are left for later. */
export const READ_SCAN_FACTOR = 20;

/** A reader and the routes it is offered. The order of the list is the order
 *  readers are asked in. */
export interface RegisteredReader {
  readonly reader: DocumentReader;
  readonly routes: readonly IntakeRoute[];
}

export interface ItemFailure {
  readonly intakeItemId: string;
  /** The reader that threw, when one did (the item then has a `failed`
   *  read); null for a fault outside any reader (the item stays unread). */
  readonly reader: Reader | null;
  readonly error: string;
}

export interface ReadSweepReport {
  readonly tenantId: string;
  /** Reads written on this run. */
  readonly read: number;
  readonly staged: number;
  readonly needsPerson: number;
  readonly failed: number;
  /** Lines written with them. */
  readonly lines: number;
  /** Of the reads that went to a person, how many for each reason. */
  readonly byProblem: Readonly<Partial<Record<ReadProblem, number>>>;
  /** Items a reader answered `later` for (or that waited on a reader already
   *  resting): left unread, offered again next run. */
  readonly later: number;
  /** Items another run read first, between the read and the insert. */
  readonly alreadyRead: number;
  /** Items something went wrong for, in order. */
  readonly failures: readonly ItemFailure[];
  /** The run stopped with unread items it did not look at. */
  readonly more: boolean;
  /** The firm could not be swept at all. */
  readonly failure?: string;
}

export interface ReadSweepDeps {
  readonly firms: FinFirms;
  readonly store: ReadStore;
  readonly bytes: VersionBytes;
  readonly readers: readonly RegisteredReader[];
  readonly events: EventSink;
  readonly ids: IdGen;
  readonly batchSize?: number;
}

/** What one item came to, before it is written. */
interface Outcome {
  readonly reader: Reader | null;
  readonly docKind: DocKind;
  readonly status: ReadStatus;
  readonly problem: ReadProblem | null;
  readonly draft: ReadDraft | null;
}

const NO_READER: Outcome = { reader: null, docKind: "unknown", status: "needs_person", problem: "no_reader", draft: null };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class Tally {
  read = 0;
  staged = 0;
  needsPerson = 0;
  failed = 0;
  lines = 0;
  later = 0;
  alreadyRead = 0;
  readonly byProblem: Partial<Record<ReadProblem, number>> = {};
  readonly failures: ItemFailure[] = [];

  wrote(status: ReadStatus, problem: ReadProblem | null, lines: number): void {
    this.read += 1;
    this.lines += lines;
    if (status === "staged") this.staged += 1;
    else if (status === "needs_person") this.needsPerson += 1;
    else this.failed += 1;
    if (problem !== null) this.byProblem[problem] = (this.byProblem[problem] ?? 0) + 1;
  }

  report(tenantId: string, more: boolean): ReadSweepReport {
    return {
      tenantId,
      read: this.read,
      staged: this.staged,
      needsPerson: this.needsPerson,
      failed: this.failed,
      lines: this.lines,
      byProblem: { ...this.byProblem },
      later: this.later,
      alreadyRead: this.alreadyRead,
      failures: [...this.failures],
      more,
    };
  }
}

export class FinReadSweep {
  constructor(private readonly deps: ReadSweepDeps) {}

  async sweep(): Promise<readonly ReadSweepReport[]> {
    const reports: ReadSweepReport[] = [];
    for (const tenantId of await this.deps.firms.enabledFirmIds()) {
      try {
        reports.push(await this.sweepFirm(tenantId));
      } catch (err) {
        reports.push({ ...new Tally().report(tenantId, false), failure: messageOf(err) });
      }
    }
    return reports;
  }

  async sweepFirm(tenantId: string): Promise<ReadSweepReport> {
    const batch = this.deps.batchSize ?? READ_BATCH;
    const scanCap = batch * READ_SCAN_FACTOR;
    const routes = [...new Set<IntakeRoute>([...this.deps.readers.flatMap((r) => r.routes), "manual"])];
    const tally = new Tally();
    const resting = new Set<Reader>();
    let after: string | null = null;
    let scanned = 0;

    for (;;) {
      const page = await this.deps.store.unread(tenantId, routes, after, batch);
      for (const item of page) {
        if (tally.read >= batch || scanned >= scanCap) return tally.report(tenantId, true);
        after = item.intakeItemId;
        scanned += 1;
        await this.readOne(tenantId, item, resting, tally);
      }
      if (page.length < batch) return tally.report(tenantId, false);
    }
  }

  private async readOne(tenantId: string, item: UnreadItem, resting: Set<Reader>, tally: Tally): Promise<void> {
    try {
      const outcome = await this.outcomeOf(tenantId, item, resting, tally);
      if (outcome !== null) await this.write(tenantId, item, outcome, tally);
    } catch (err) {
      tally.failures.push({ intakeItemId: item.intakeItemId, reader: null, error: messageOf(err) });
    }
  }

  /** What the readers make of one item; null when it is left unread. */
  private async outcomeOf(
    tenantId: string,
    item: UnreadItem,
    resting: Set<Reader>,
    tally: Tally,
  ): Promise<Outcome | null> {
    if (item.route === "manual") return NO_READER;
    const offered = this.deps.readers.filter((r) => r.routes.includes(item.route)).map((r) => r.reader);
    if (offered.length === 0) return null;
    if (offered.every((r) => resting.has(r.name))) {
      tally.later += 1;
      return null;
    }

    const bytes = await this.deps.bytes.fetch(tenantId, item.documentVersionId);
    if (bytes === null) {
      tally.failures.push({
        intakeItemId: item.intakeItemId,
        reader: null,
        error: `the bytes of document version ${item.documentVersionId} are missing from the store`,
      });
      return null;
    }
    const input: ReadInput = {
      tenantId,
      intakeItemId: item.intakeItemId,
      documentVersionId: item.documentVersionId,
      clientPartyId: item.clientPartyId,
      route: item.route,
      mediaType: item.mediaType,
      filename: item.filename,
      bytes,
    };

    for (const reader of offered) {
      if (resting.has(reader.name)) {
        tally.later += 1;
        return null;
      }
      let answer: ReadOutcome;
      try {
        answer = await reader.read(input);
      } catch (err) {
        tally.failures.push({ intakeItemId: item.intakeItemId, reader: reader.name, error: messageOf(err) });
        return { reader: reader.name, docKind: "unknown", status: "failed", problem: "unreadable", draft: null };
      }
      switch (answer.kind) {
        case "not_mine":
          continue;
        case "later":
          resting.add(reader.name);
          tally.later += 1;
          return null;
        case "needs_person":
          // `no_reader` is the sweep's answer when nobody takes a file, so a
          // reader saying it is passing the file on. `control_mismatch` is the
          // sweep's too, decided from a draft; a reader claiming it without
          // one is a reader fault, and the file is parked rather than looped.
          if (answer.problem === "no_reader") continue;
          if (answer.problem === "control_mismatch") {
            tally.failures.push({
              intakeItemId: item.intakeItemId,
              reader: reader.name,
              error: "the reader answered control_mismatch without a draft; only the sweep decides that",
            });
            return { reader: reader.name, docKind: "unknown", status: "failed", problem: "unreadable", draft: null };
          }
          return { reader: answer.reader, docKind: "unknown", status: "needs_person", problem: answer.problem, draft: null };
        case "read":
          return {
            reader: answer.draft.reader,
            docKind: answer.draft.docKind,
            status: "staged",
            problem: null,
            draft: answer.draft,
          };
      }
    }
    return NO_READER;
  }

  private async write(tenantId: string, item: UnreadItem, outcome: Outcome, tally: Tally): Promise<void> {
    let status = outcome.status;
    let problem = outcome.problem;
    let control: StoredControl | null = null;
    let controlOk: boolean | null = null;
    if (outcome.draft !== null) {
      const decided = decideRead(outcome.draft);
      status = decided.status;
      problem = decided.problem;
      control = decided.control;
      controlOk = decided.controlOk;
    }
    const draftLines = outcome.draft?.lines ?? [];
    const lines: NewLine[] = draftLines.map((draft, i) => ({ id: this.deps.ids.newId(), position: i + 1, draft }));
    const readId = this.deps.ids.newId();

    const created = await this.deps.store.insert(
      {
        id: readId,
        tenantId,
        intakeItemId: item.intakeItemId,
        documentVersionId: item.documentVersionId,
        clientPartyId: item.clientPartyId,
        reader: outcome.reader,
        docKind: outcome.docKind,
        status,
        problem,
        formatId: outcome.draft?.formatId ?? null,
        control,
        controlOk,
        confidence: outcome.draft?.confidence ?? null,
        model: outcome.draft?.model ?? null,
        promptVersion: outcome.draft?.promptVersion ?? null,
      },
      lines,
    );
    if (!created) {
      tally.alreadyRead += 1;
      return;
    }
    tally.wrote(status, problem, lines.length);

    const reader = outcome.reader;
    const docKind = outcome.docKind;
    const lineCount = lines.length;
    await this.deps.events.recordEvent({
      tenantId,
      verb: "fin.document_read",
      objectId: readId,
      actor: SYSTEM_ACTOR,
      payload: {
        readId,
        intakeItemId: item.intakeItemId,
        documentVersionId: item.documentVersionId,
        reader,
        docKind,
        status,
        problem,
        lineCount,
        controlOk,
      },
    });
  }
}
