// In-memory fakes for FinCompliance's ports. `implements` is the compile-time
// assertion that they stay in step with the Postgres adapters.
//
// They reproduce what the sweep's rules depend on — the per-firm switch, the
// anti-join (a version taken in is never a candidate again) and the insert
// conflict — and nothing else. RLS and the grants are database properties,
// proven against real Postgres in tests/fin/intake.integration.test.ts.
import type { DocumentKind } from "../domain/filestore/model";
import { INTAKE_ROUTES } from "../domain/fin/intake";
import type { IntakeRoute } from "../domain/fin/intake";
import type {
  FinFirms,
  IntakeCandidate,
  IntakeCandidateSource,
  IntakeFilter,
  IntakeItemView,
  IntakeRepository,
  IntakeSummary,
  NewIntakeItem,
} from "../usecase/fin/ports";

export class FakeFinFirms implements FinFirms {
  readonly enabled = new Set<string>();

  enabledFirmIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.enabled]);
  }
  enabledSince(tenantId: string): Promise<string | null> {
    return Promise.resolve(this.enabled.has(tenantId) ? "2026-10-10T12:00:00.000Z" : null);
  }
}

export interface StoredFile extends IntakeCandidate {
  readonly tenantId: string;
  readonly kind: DocumentKind;
  readonly origin: "generated" | "uploaded";
  readonly title: string;
  readonly documentId: string;
}

/** One store behind both ports, as the database is: the candidate read is an
 *  anti-join against the very rows `insert` writes. */
export class FakeFinIntakeStore implements IntakeCandidateSource, IntakeRepository {
  readonly files: StoredFile[] = [];
  readonly items: NewIntakeItem[] = [];
  /** Firms whose candidate read throws, to prove one firm cannot stop another. */
  readonly broken = new Set<string>();
  /** Versions another run takes in between this run's read and its insert. */
  readonly raced = new Set<string>();

  untaken(
    tenantId: string,
    kinds: readonly DocumentKind[],
    limit: number,
  ): Promise<readonly IntakeCandidate[]> {
    if (this.broken.has(tenantId)) return Promise.reject(new Error(`firm ${tenantId} is unreadable`));
    const taken = new Set(this.items.filter((i) => i.tenantId === tenantId).map((i) => i.documentVersionId));
    return Promise.resolve(
      this.files
        .filter((f) => f.tenantId === tenantId)
        .filter((f) => f.origin === "uploaded" && kinds.includes(f.kind))
        .filter((f) => !taken.has(f.documentVersionId))
        .slice(0, limit),
    );
  }

  insert(item: NewIntakeItem): Promise<boolean> {
    if (this.raced.has(item.documentVersionId)) {
      this.raced.delete(item.documentVersionId);
      this.items.push({ ...item, id: `${item.id}-other-run` });
      return Promise.resolve(false);
    }
    const exists = this.items.some(
      (i) => i.tenantId === item.tenantId && i.documentVersionId === item.documentVersionId,
    );
    if (exists) return Promise.resolve(false);
    this.items.push(item);
    return Promise.resolve(true);
  }

  /** Newest first is insertion order reversed, which is what `created_at` gives
   *  the adapter. */
  list(tenantId: string, filter: IntakeFilter): Promise<readonly IntakeItemView[]> {
    let rows = this.items
      .filter((i) => i.tenantId === tenantId)
      .filter((i) => filter.clientPartyId === null || i.clientPartyId === filter.clientPartyId)
      .filter((i) => filter.route === null || i.route === filter.route)
      .reverse();
    if (filter.before !== null) {
      const at = rows.findIndex((i) => i.id === filter.before);
      rows = at === -1 ? [] : rows.slice(at + 1);
    }
    const views = rows
      .slice(0, filter.limit)
      .map((i): IntakeItemView => {
        const file = this.files.find((f) => f.documentVersionId === i.documentVersionId);
        return {
          id: i.id,
          documentId: file?.documentId ?? i.documentVersionId,
          documentVersionId: i.documentVersionId,
          title: file?.title ?? "",
          filename: file?.filename ?? "",
          clientPartyId: i.clientPartyId,
          clientName: null,
          mediaType: i.mediaType,
          byteSize: i.byteSize,
          route: i.route,
          routeBasis: i.routeBasis,
          takenAt: "2026-10-10T00:00:00.000Z",
        };
      });
    return Promise.resolve(views);
  }

  summary(tenantId: string, clientPartyId: string | null): Promise<IntakeSummary> {
    const rows = this.items
      .filter((i) => i.tenantId === tenantId)
      .filter((i) => clientPartyId === null || i.clientPartyId === clientPartyId);
    const byRoute = Object.fromEntries(INTAKE_ROUTES.map((r) => [r, 0])) as Record<IntakeRoute, number>;
    for (const r of rows) byRoute[r.route] += 1;
    return Promise.resolve({ total: rows.length, byRoute });
  }
}
