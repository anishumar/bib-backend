// In-memory fakes for the read sweep's and the read screens' ports.
// `implements` is the compile-time assertion that they stay in step with the
// Postgres adapters.
//
// They reproduce what the sweep's rules depend on: the anti-join (an intake
// item with a read is never unread again), the cursor, the read's unique key
// (a second insert conflicts and writes nothing), one transaction for a read
// and its lines, and a layout's fingerprint being learnt once. RLS, the CHECKs
// and the frozen `proposed` are database properties, proven against real
// Postgres in tests/fin/read.integration.test.ts.
import { DOC_KINDS } from "../domain/fin/lines";
import type { DocKind, Reader } from "../domain/fin/lines";
import type { IntakeRoute } from "../domain/fin/intake";
import { READ_STATUSES } from "../domain/fin/read";
import type { ReadStatus } from "../domain/fin/read";
import type { DocumentReader, ReadInput, ReadOutcome } from "../usecase/fin/reading";
import type {
  FirmCurrency,
  NewLine,
  NewRead,
  NewSourceFormat,
  ReadDetail,
  ReadFilter,
  ReadQueries,
  ReadStore,
  ReadSummary,
  ReadView,
  SourceFormat,
  SourceFormatStore,
  UnreadItem,
  VersionBytes,
} from "../usecase/fin/read-ports";
import type { FakeFinIntakeStore } from "./fin";

/** The reads, over the intake fake's items: one store, as the database is. */
export class FakeReadStore implements ReadStore, ReadQueries {
  readonly reads: NewRead[] = [];
  readonly lines = new Map<string, readonly NewLine[]>();
  /** Firms whose unread query throws, to prove one firm cannot stop another. */
  readonly broken = new Set<string>();
  /** Intake items another run reads between this run's read and its insert. */
  readonly raced = new Set<string>();
  /** Intake items whose insert the database refuses. */
  readonly refused = new Set<string>();
  /** Every `unread` call, to prove the cursor moves. */
  readonly pages: { after: string | null; limit: number }[] = [];

  constructor(private readonly intake: FakeFinIntakeStore) {}

  unread(
    tenantId: string,
    routes: readonly IntakeRoute[],
    after: string | null,
    limit: number,
  ): Promise<readonly UnreadItem[]> {
    this.pages.push({ after, limit });
    if (this.broken.has(tenantId)) return Promise.reject(new Error(`firm ${tenantId} is unreadable`));
    const read = new Set(this.reads.filter((r) => r.tenantId === tenantId).map((r) => r.intakeItemId));
    const items = this.intake.items.filter((i) => i.tenantId === tenantId);
    const from = after === null ? 0 : items.findIndex((i) => i.id === after) + 1;
    return Promise.resolve(
      items
        .slice(from)
        .filter((i) => routes.includes(i.route) && !read.has(i.id))
        .slice(0, limit)
        .map((i) => ({
          intakeItemId: i.id,
          documentVersionId: i.documentVersionId,
          clientPartyId: i.clientPartyId,
          route: i.route,
          mediaType: i.mediaType,
          filename: this.intake.files.find((f) => f.documentVersionId === i.documentVersionId)?.filename ?? "",
        })),
    );
  }

  insert(read: NewRead, lines: readonly NewLine[]): Promise<boolean> {
    if (this.refused.has(read.intakeItemId)) {
      return Promise.reject(new Error(`the database refused the read of ${read.intakeItemId}`));
    }
    if (this.raced.has(read.intakeItemId)) {
      this.raced.delete(read.intakeItemId);
      this.reads.push({ ...read, id: `${read.id.slice(0, -4)}ffff` });
      return Promise.resolve(false);
    }
    const exists = this.reads.some((r) => r.tenantId === read.tenantId && r.intakeItemId === read.intakeItemId);
    if (exists) return Promise.resolve(false);
    this.reads.push(read);
    this.lines.set(read.id, lines);
    return Promise.resolve(true);
  }

  private view(r: NewRead): ReadView {
    const file = this.intake.files.find((f) => f.documentVersionId === r.documentVersionId);
    return {
      id: r.id,
      intakeItemId: r.intakeItemId,
      documentId: file?.documentId ?? r.documentVersionId,
      documentVersionId: r.documentVersionId,
      title: file?.title ?? "",
      filename: file?.filename ?? "",
      clientPartyId: r.clientPartyId,
      clientName: null,
      reader: r.reader,
      docKind: r.docKind,
      status: r.status,
      problem: r.problem,
      controlOk: r.controlOk,
      lineCount: this.lines.get(r.id)?.length ?? 0,
      confidence: r.confidence,
      readAt: "2026-10-11T00:00:00.000Z",
    };
  }

  /** Newest first is insertion order reversed. */
  list(tenantId: string, filter: ReadFilter): Promise<readonly ReadView[]> {
    let rows = this.reads
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => filter.clientPartyId === null || r.clientPartyId === filter.clientPartyId)
      .filter((r) => filter.status === null || r.status === filter.status)
      .filter((r) => filter.docKind === null || r.docKind === filter.docKind)
      .reverse();
    if (filter.before !== null) {
      const at = rows.findIndex((r) => r.id === filter.before);
      rows = at === -1 ? [] : rows.slice(at + 1);
    }
    return Promise.resolve(rows.slice(0, filter.limit).map((r) => this.view(r)));
  }

  summary(tenantId: string, clientPartyId: string | null): Promise<ReadSummary> {
    const rows = this.reads
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => clientPartyId === null || r.clientPartyId === clientPartyId);
    const byStatus = Object.fromEntries(READ_STATUSES.map((s) => [s, 0])) as Record<ReadStatus, number>;
    const byDocKind = Object.fromEntries(DOC_KINDS.map((k) => [k, 0])) as Record<DocKind, number>;
    for (const r of rows) {
      byStatus[r.status] += 1;
      byDocKind[r.docKind] += 1;
    }
    return Promise.resolve({ total: rows.length, byStatus, byDocKind });
  }

  get(tenantId: string, readId: string): Promise<ReadDetail | null> {
    const r = this.reads.find((x) => x.tenantId === tenantId && x.id === readId);
    if (r === undefined) return Promise.resolve(null);
    return Promise.resolve({
      ...this.view(r),
      control: r.control,
      model: r.model,
      promptVersion: r.promptVersion,
      format: null,
      lines: (this.lines.get(r.id) ?? []).map((l) => ({
        id: l.id,
        position: l.position,
        status: "staged" as const,
        values: l.draft,
        proposed: l.draft,
      })),
    });
  }
}

/** Bytes by version, each the firm's that stored it. */
export class FakeVersionBytes implements VersionBytes {
  readonly bytes = new Map<string, { tenantId: string; bytes: Uint8Array }>();
  /** How many fetches, to prove a resting reader's file is not fetched. */
  fetched = 0;

  put(tenantId: string, documentVersionId: string, bytes: Uint8Array): void {
    this.bytes.set(documentVersionId, { tenantId, bytes });
  }

  fetch(tenantId: string, documentVersionId: string): Promise<Uint8Array | null> {
    this.fetched += 1;
    const held = this.bytes.get(documentVersionId);
    return Promise.resolve(held === undefined || held.tenantId !== tenantId ? null : held.bytes);
  }
}

export class FakeSourceFormats implements SourceFormatStore {
  readonly rows: (NewSourceFormat & { readonly confirmedAt: string | null; readonly seq: number })[] = [];
  private seq = 0;

  current(tenantId: string, fingerprints: readonly string[]): Promise<readonly SourceFormat[]> {
    const out: SourceFormat[] = [];
    for (const fp of new Set(fingerprints)) {
      const held = this.rows.filter((r) => r.tenantId === tenantId && r.fingerprint === fp);
      const confirmed = held.filter((r) => r.confirmedAt !== null).sort((a, b) => b.seq - a.seq)[0];
      const pick = confirmed ?? held.find((r) => r.confirmedAt === null);
      if (pick !== undefined) out.push(this.toFormat(pick));
    }
    return Promise.resolve(out);
  }

  learn(format: NewSourceFormat): Promise<string> {
    const held = this.rows.find(
      (r) => r.tenantId === format.tenantId && r.fingerprint === format.fingerprint && r.confirmedAt === null,
    );
    if (held !== undefined) return Promise.resolve(held.id);
    this.seq += 1;
    this.rows.push({ ...format, confirmedByUserId: null, confirmedAt: null, seq: this.seq });
    return Promise.resolve(format.id);
  }

  confirm(format: NewSourceFormat): Promise<string> {
    this.seq += 1;
    this.rows.push({ ...format, confirmedAt: "2026-10-11T00:00:00.000Z", seq: this.seq });
    return Promise.resolve(format.id);
  }

  get(tenantId: string, formatId: string): Promise<SourceFormat | null> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === formatId);
    return Promise.resolve(row === undefined ? null : this.toFormat(row));
  }

  private toFormat(r: NewSourceFormat & { readonly confirmedAt: string | null }): SourceFormat {
    return {
      id: r.id,
      fingerprint: r.fingerprint,
      container: r.container,
      header: r.header,
      headerRow: r.headerRow,
      docKind: r.docKind,
      columns: r.columns,
      dateFormat: r.dateFormat,
      amountStyle: r.amountStyle,
      learntFromIntakeItemId: r.learntFromIntakeItemId,
      basedOnFormatId: r.basedOnFormatId,
      confirmedByUserId: r.confirmedByUserId,
      confirmedAt: r.confirmedAt,
    };
  }
}

export class FakeFirmCurrency implements FirmCurrency {
  constructor(private readonly currency = "SGD") {}
  reportingCurrency(): Promise<string> {
    return Promise.resolve(this.currency);
  }
}

/** A reader whose answers a test writes: one function, and a log of what it
 *  was offered. */
export class ScriptedReader implements DocumentReader {
  readonly offered: string[] = [];

  constructor(
    readonly name: Reader,
    private readonly answer: (input: ReadInput) => ReadOutcome | Promise<ReadOutcome>,
  ) {}

  read(input: ReadInput): Promise<ReadOutcome> {
    this.offered.push(input.intakeItemId);
    try {
      return Promise.resolve(this.answer(input));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
