// What FinCompliance read, for the staff screens (docs/FIN_BUILD_PLAN.md F2.5,
// F2.8's list): the reads newest first, a page at a time with counts, and one
// read with its lines.
//
// Read-only, and on the API's pool: the read sweep in the fin job is the only
// writer of reads. A firm with fin switched off is told fin is not there
// (`FinNotEnabled`, a 404), the intake list's rule.
import { FinNotEnabled, FinReadNotFound } from "../../domain/fin/errors";
import type { FinFirms } from "./ports";
import type { ReadDetail, ReadFilter, ReadQueries, ReadSummary, ReadView } from "./read-ports";

export interface ReadQueryDeps {
  readonly firms: FinFirms;
  readonly reads: ReadQueries;
}

export interface ReadPage {
  readonly items: readonly ReadView[];
  /** For the same CLIENT filter, never for the page alone and never narrowed
   *  by the status or kind being looked at: "12 wait for a person" must not
   *  change as somebody pages or clicks a tile. */
  readonly summary: ReadSummary;
  /** Pass back as `before` for the next page; null when this is the last. */
  readonly nextBefore: string | null;
}

export class FinReadQueries {
  constructor(private readonly deps: ReadQueryDeps) {}

  private async requireEnabled(tenantId: string): Promise<void> {
    if ((await this.deps.firms.enabledSince(tenantId)) === null) throw new FinNotEnabled();
  }

  async list(tenantId: string, filter: ReadFilter): Promise<ReadPage> {
    await this.requireEnabled(tenantId);
    // One more than the page, to know whether there is a next one.
    const rows = await this.deps.reads.list(tenantId, { ...filter, limit: filter.limit + 1 });
    const items = rows.slice(0, filter.limit);
    const last = items.at(-1);
    const summary = await this.deps.reads.summary(tenantId, filter.clientPartyId);
    return { items, summary, nextBefore: rows.length > filter.limit && last !== undefined ? last.id : null };
  }

  async get(tenantId: string, readId: string): Promise<ReadDetail> {
    await this.requireEnabled(tenantId);
    const read = await this.deps.reads.get(tenantId, readId);
    if (read === null) throw new FinReadNotFound(readId);
    return read;
  }
}
