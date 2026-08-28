// Postgres adapter for engagement letters and the engagements they create.
// Every method runs under withTenant, so the RLS tenant wall applies to each
// statement. `numeric` arrives as a string and stays one — money never becomes
// a JavaScript number on the way through this file.
//
// Two methods here open a transaction of their own inside the tenant scope, and
// both do it for the same reason: the states in between are ones a person would
// have to repair by hand.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  Engagement,
  EngagementLetter,
  EngagementStatus,
  LetterClause,
  LetterLine,
  LetterStatus,
} from "../../domain/engagement/model";
import { readClauseBody } from "../../domain/config/model";
import type {
  EngagementRepository,
  LetterClauseRecord,
  LetterFilters,
  LetterLineRecord,
  LetterRecord,
  LetterSummary,
  NewEngagement,
  NewLetter,
  NewLetterClause,
  NewLetterLine,
  SignatureRecord,
} from "../../usecase/engagement/ports";

interface LetterRow {
  id: string;
  tenant_id: string;
  ref: string;
  party_id: string;
  issuing_entity_party_id: string;
  proposal_id: string | null;
  jurisdiction: string;
  title: string;
  status: LetterStatus;
  currency: string;
  fx_rate: string;
  fx_rate_date: Date;
  advance_required: boolean;
  advance_amount: string | null;
  advance_recorded_at: Date | null;
  advance_recorded_by: string | null;
  sent_at: Date | null;
  signed_at: Date | null;
  signed_by_name: string | null;
  signature_method: string | null;
  signature_reference: string | null;
  signed_content_hash: string | null;
  withdrawn_at: Date | null;
}

interface LineRow {
  id: string;
  tenant_id: string;
  engagement_letter_id: string;
  entity_party_id: string;
  service_version_id: string;
  description: string;
  position: number;
  quantity: string;
  unit_amount: string;
  currency: string;
  discount_percent: string;
}

interface ClauseRow {
  id: string;
  tenant_id: string;
  engagement_letter_id: string;
  clause_version_id: string;
  position: number;
}

interface EngagementRow {
  id: string;
  tenant_id: string;
  engagement_letter_id: string;
  engagement_letter_line_id: string;
  party_id: string;
  entity_party_id: string;
  status: EngagementStatus;
  activated_at: Date | null;
  ends_on: Date | null;
}

/** A date column, as a day. `toISOString().slice(0,10)` would be wrong east of
 *  UTC: node builds the Date at local midnight and converting can move it back. */
function toDay(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(year)}-${month}-${day}`;
}

function toLetter(r: LetterRow): EngagementLetter {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    ref: r.ref,
    partyId: r.party_id,
    issuingEntityPartyId: r.issuing_entity_party_id,
    proposalId: r.proposal_id,
    jurisdiction: r.jurisdiction,
    title: r.title,
    status: r.status,
    currency: r.currency,
    fxRate: r.fx_rate,
    fxRateDate: toDay(r.fx_rate_date),
    advanceRequired: r.advance_required,
    advanceAmount: r.advance_amount,
    advanceRecordedAt: r.advance_recorded_at?.toISOString() ?? null,
    advanceRecordedBy: r.advance_recorded_by,
    sentAt: r.sent_at?.toISOString() ?? null,
    signedAt: r.signed_at?.toISOString() ?? null,
    signedByName: r.signed_by_name,
    signatureMethod: r.signature_method,
    signatureReference: r.signature_reference,
    signedContentHash: r.signed_content_hash,
    withdrawnAt: r.withdrawn_at?.toISOString() ?? null,
  };
}

function toLine(r: LineRow): LetterLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    engagementLetterId: r.engagement_letter_id,
    entityPartyId: r.entity_party_id,
    serviceVersionId: r.service_version_id,
    description: r.description,
    position: r.position,
    quantity: r.quantity,
    unitAmount: r.unit_amount,
    currency: r.currency,
    discountPercent: r.discount_percent,
  };
}

function toClause(r: ClauseRow): LetterClause {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    engagementLetterId: r.engagement_letter_id,
    clauseVersionId: r.clause_version_id,
    position: r.position,
  };
}

function toEngagement(r: EngagementRow): Engagement {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    engagementLetterId: r.engagement_letter_id,
    engagementLetterLineId: r.engagement_letter_line_id,
    partyId: r.party_id,
    entityPartyId: r.entity_party_id,
    status: r.status,
    activatedAt: r.activated_at?.toISOString() ?? null,
    endsOn: r.ends_on === null ? null : toDay(r.ends_on),
  };
}

export class PostgresEngagementRepository implements EngagementRepository {
  constructor(private readonly app: Db) {}

  async create(l: NewLetter): Promise<EngagementLetter> {
    return withTenant(this.app, l.tenantId, async (db) => {
      const [row] = await db<LetterRow[]>`
        INSERT INTO crm.engagement_letter
          (id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id, jurisdiction,
           title, currency, fx_rate, fx_rate_date, advance_required, advance_amount)
        VALUES
          (${l.id}, ${l.tenantId}, ${l.ref}, ${l.partyId}, ${l.issuingEntityPartyId},
           ${l.proposalId}, ${l.jurisdiction}, ${l.title},
           ${l.currency}, ${l.fxRate}, ${l.fxRateDate}, ${l.advanceRequired}, ${l.advanceAmount})
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                  jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
                  advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
                  signature_method, signature_reference, signed_content_hash, withdrawn_at
      `;
      if (!row) throw new Error("engagement letter insert returned no row");
      return toLetter(row);
    });
  }

  async findLetter(tenantId: string, letterId: string): Promise<EngagementLetter | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LetterRow[]>`
        SELECT id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
               jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
               advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
               signature_method, signature_reference, signed_content_hash, withdrawn_at
        FROM crm.engagement_letter WHERE id = ${letterId}
      `;
      return row ? toLetter(row) : null;
    });
  }

  async describeLetter(tenantId: string, letterId: string): Promise<LetterRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [head] = await db<
        (LetterRow & { party_display_name: string; issuer_display_name: string })[]
      >`
        SELECT l.id, l.tenant_id, l.ref, l.party_id, l.issuing_entity_party_id,
               l.proposal_id, l.jurisdiction, l.title, l.status,
               l.currency, l.fx_rate, l.fx_rate_date, l.advance_required, l.advance_amount,
               l.advance_recorded_at, l.advance_recorded_by, l.sent_at, l.signed_at,
               l.signed_by_name, l.signature_method, l.signature_reference,
               l.signed_content_hash, l.withdrawn_at,
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name
        FROM crm.engagement_letter l
        JOIN core.party party ON party.id = l.party_id
        -- WHICH OF OUR COMPANIES is contracting, by name — the letterhead and
        -- the signature block both print it. An inner join: the column is NOT
        -- NULL and carries the tenant, so an unresolvable issuer is corruption
        -- rather than a state to render.
        JOIN core.party issuer ON issuer.id = l.issuing_entity_party_id
        WHERE l.id = ${letterId}
      `;
      if (!head) return null;

      const lines = await db<
        (LineRow & {
          net: string;
          service_key: string;
          service_version: number;
          service_body: Record<string, unknown>;
          entity_display_name: string;
        })[]
      >`
        SELECT l.id, l.tenant_id, l.engagement_letter_id, l.entity_party_id,
               l.service_version_id, l.description,
               l.position, l.quantity, l.unit_amount, l.currency, l.discount_percent,
               round(l.unit_amount * l.quantity * (1 - l.discount_percent / 100), 4) AS net,
               e.key AS service_key, v.version AS service_version, v.body AS service_body,
               entity.display_name AS entity_display_name
        FROM crm.engagement_letter_line l
        JOIN config.version v ON v.id = l.service_version_id
        JOIN config.entry e ON e.id = v.entry_id
        -- The entity by NAME, in the query rather than per row on a screen.
        -- This is where a group client's four companies are told apart, so a
        -- column of uuids is the one thing this read must not return.
        JOIN core.party entity ON entity.id = l.entity_party_id
        WHERE l.engagement_letter_id = ${letterId} AND l.removed_at IS NULL
        ORDER BY l.position
      `;

      // The clauses, with the wording AS PINNED. This join is the whole design:
      // reading a signed letter must show what was agreed, not what the library
      // says today.
      const clauses = await db<
        (ClauseRow & { clause_key: string; clause_version: number; clause_body: Record<string, unknown> })[]
      >`
        SELECT c.id, c.tenant_id, c.engagement_letter_id, c.clause_version_id, c.position,
               e.key AS clause_key, v.version AS clause_version, v.body AS clause_body
        FROM crm.engagement_letter_clause c
        JOIN config.version v ON v.id = c.clause_version_id
        JOIN config.entry e ON e.id = v.entry_id
        WHERE c.engagement_letter_id = ${letterId}
        ORDER BY c.position
      `;

      const [totals] = await db<{ gross: string | null; discount: string | null; net: string | null }[]>`
        SELECT coalesce(sum(round(unit_amount * quantity, 4)), 0) AS gross,
               coalesce(sum(round(unit_amount * quantity, 4)
                          - round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                 AS discount,
               coalesce(sum(round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                 AS net
        FROM crm.engagement_letter_line
        WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
      `;

      const engagements = await db<EngagementRow[]>`
        SELECT id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
               entity_party_id, status, activated_at, ends_on
        FROM crm.engagement WHERE engagement_letter_id = ${letterId}
      `;

      return {
        letter: toLetter(head),
        party: { id: head.party_id, displayName: head.party_display_name },
        issuingEntity: {
          id: head.issuing_entity_party_id,
          displayName: head.issuer_display_name,
        },
        lines: lines.map(
          (r): LetterLineRecord => ({
            line: toLine(r),
            entity: { id: r.entity_party_id, displayName: r.entity_display_name },
            service: {
              key: r.service_key,
              version: r.service_version,
              name:
                typeof r.service_body["name"] === "string" ? r.service_body["name"] : r.service_key,
            },
            net: r.net,
          }),
        ),
        clauses: clauses.map((r): LetterClauseRecord => {
          const body = readClauseBody(r.clause_body);
          return {
            clause: toClause(r),
            key: r.clause_key,
            version: r.clause_version,
            title: body.title,
            text: body.text,
          };
        }),
        totals: {
          gross: totals?.gross ?? "0",
          discount: totals?.discount ?? "0",
          net: totals?.net ?? "0",
          currency: head.currency,
        },
        engagements: engagements.map(toEngagement),
      };
    });
  }

  async listLetters(tenantId: string, filters: LetterFilters): Promise<readonly LetterSummary[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        (LetterRow & {
          party_display_name: string;
          issuer_display_name: string;
          gross: string | null;
          discount: string | null;
          net: string | null;
          line_count: string;
        })[]
      >`
        SELECT l.id, l.tenant_id, l.ref, l.party_id, l.issuing_entity_party_id,
               l.proposal_id, l.jurisdiction, l.title, l.status,
               l.currency, l.fx_rate, l.fx_rate_date, l.advance_required, l.advance_amount,
               l.advance_recorded_at, l.advance_recorded_by, l.sent_at, l.signed_at,
               l.signed_by_name, l.signature_method, l.signature_reference,
               l.signed_content_hash, l.withdrawn_at,
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name,
               t.gross, t.discount, t.net, coalesce(t.line_count, 0) AS line_count
        FROM crm.engagement_letter l
        JOIN core.party party ON party.id = l.party_id
        JOIN core.party issuer ON issuer.id = l.issuing_entity_party_id
        LEFT JOIN LATERAL (
          SELECT coalesce(sum(round(unit_amount * quantity, 4)), 0) AS gross,
                 coalesce(sum(round(unit_amount * quantity, 4)
                            - round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                   AS discount,
                 coalesce(sum(round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                   AS net,
                 count(*) AS line_count
          FROM crm.engagement_letter_line
          WHERE engagement_letter_id = l.id AND removed_at IS NULL
        ) t ON true
        WHERE (${filters.status ?? null}::text IS NULL OR l.status = ${filters.status ?? null})
          AND (${filters.partyId ?? null}::uuid IS NULL OR l.party_id = ${filters.partyId ?? null})
        ORDER BY l.created_at DESC
      `;
      return rows.map(
        (r): LetterSummary => ({
          letter: toLetter(r),
          party: { id: r.party_id, displayName: r.party_display_name },
          issuingEntity: { id: r.issuing_entity_party_id, displayName: r.issuer_display_name },
          totals: {
            gross: r.gross ?? "0",
            discount: r.discount ?? "0",
            net: r.net ?? "0",
            currency: r.currency,
          },
          lineCount: Number(r.line_count),
        }),
      );
    });
  }

  async addLine(l: NewLetterLine): Promise<LetterLine> {
    return withTenant(this.app, l.tenantId, async (db) => {
      // The position is assigned in the same statement that inserts, so two
      // people adding a line to one draft cannot race for the same number.
      const [row] = await db<LineRow[]>`
        INSERT INTO crm.engagement_letter_line
          (id, tenant_id, engagement_letter_id, entity_party_id, service_version_id,
           description, position, quantity, unit_amount, currency, discount_percent)
        SELECT ${l.id}, ${l.tenantId}, ${l.engagementLetterId}, ${l.entityPartyId},
               ${l.serviceVersionId},
               ${l.description}, coalesce(max(position), 0) + 1,
               ${l.quantity}, ${l.unitAmount}, ${l.currency}, ${l.discountPercent}
        FROM crm.engagement_letter_line
        WHERE engagement_letter_id = ${l.engagementLetterId} AND removed_at IS NULL
        RETURNING id, tenant_id, engagement_letter_id, entity_party_id, service_version_id,
                  description, position, quantity, unit_amount, currency, discount_percent
      `;
      if (!row) throw new Error("engagement letter line insert returned no row");
      return toLine(row);
    });
  }

  async removeLine(tenantId: string, letterId: string, lineId: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE crm.engagement_letter_line SET removed_at = now()
        WHERE id = ${lineId} AND engagement_letter_id = ${letterId} AND removed_at IS NULL
      `;
    });
  }

  async listLines(tenantId: string, letterId: string): Promise<readonly LetterLine[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<LineRow[]>`
        SELECT id, tenant_id, engagement_letter_id, entity_party_id, service_version_id,
               description, position, quantity, unit_amount, currency, discount_percent
        FROM crm.engagement_letter_line
        WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
        ORDER BY position
      `;
      return rows.map(toLine);
    });
  }

  async addClause(c: NewLetterClause): Promise<LetterClause> {
    return withTenant(this.app, c.tenantId, async (db) => {
      const [row] = await db<ClauseRow[]>`
        INSERT INTO crm.engagement_letter_clause
          (id, tenant_id, engagement_letter_id, clause_version_id, position)
        SELECT ${c.id}, ${c.tenantId}, ${c.engagementLetterId}, ${c.clauseVersionId},
               coalesce(max(position), 0) + 1
        FROM crm.engagement_letter_clause
        WHERE engagement_letter_id = ${c.engagementLetterId}
        RETURNING id, tenant_id, engagement_letter_id, clause_version_id, position
      `;
      if (!row) throw new Error("engagement letter clause insert returned no row");
      return toClause(row);
    });
  }

  async listClauses(tenantId: string, letterId: string): Promise<readonly LetterClause[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<ClauseRow[]>`
        SELECT id, tenant_id, engagement_letter_id, clause_version_id, position
        FROM crm.engagement_letter_clause
        WHERE engagement_letter_id = ${letterId}
        ORDER BY position
      `;
      return rows.map(toClause);
    });
  }

  async setStatus(
    tenantId: string,
    letterId: string,
    status: LetterStatus,
    at: string,
  ): Promise<EngagementLetter> {
    return withTenant(this.app, tenantId, async (db) => {
      // The casts are load-bearing: a bare parameter inside a CASE whose other
      // branch is NULL has no type to infer, so Postgres calls it text and
      // refuses to assign it to a timestamptz. Learnt on proposals.
      const [row] = await db<LetterRow[]>`
        UPDATE crm.engagement_letter
           SET status = ${status},
               sent_at = CASE WHEN ${status} = 'draft' THEN NULL
                              ELSE coalesce(sent_at, ${at}::timestamptz) END,
               withdrawn_at = CASE WHEN ${status} = 'withdrawn' THEN ${at}::timestamptz
                                   ELSE NULL END
         WHERE id = ${letterId}
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                  jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
                  advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
                  signature_method, signature_reference, signed_content_hash, withdrawn_at
      `;
      if (!row) throw new Error(`engagement letter ${letterId} vanished mid-transition`);
      return toLetter(row);
    });
  }

  /**
   * THE FAN-OUT. One transaction, and that is the whole point of the method
   * existing at all: a letter signed with no engagements is a client committed
   * to work nobody scheduled, and engagements with no signature is work nobody
   * agreed to. Both are repairable only by hand.
   */
  async signAndFanOut(
    tenantId: string,
    letterId: string,
    signature: SignatureRecord,
    engagements: readonly NewEngagement[],
  ): Promise<{ letter: EngagementLetter; engagements: readonly Engagement[] }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [letter] = await db<LetterRow[]>`
        UPDATE crm.engagement_letter
           SET status = 'signed',
               signed_at = ${signature.signedAt}::timestamptz,
               signed_by_name = ${signature.signedByName},
               signature_method = ${signature.signatureMethod},
               signature_reference = ${signature.signatureReference},
               signed_content_hash = ${signature.signedContentHash}
         WHERE id = ${letterId} AND status = 'sent'
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                  jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
                  advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
                  signature_method, signature_reference, signed_content_hash, withdrawn_at
      `;
      // `AND status = 'sent'` makes the transition itself the lock: two
      // concurrent signatures cannot both find the row in that state, so the
      // second gets no row rather than a second fan-out.
      if (!letter) {
        throw new Error(
          `engagement letter ${letterId} was not in 'sent' state when the signature landed — ` +
            `it may have been signed or withdrawn concurrently`,
        );
      }

      const created: Engagement[] = [];
      for (const e of engagements) {
        const [row] = await db<EngagementRow[]>`
          INSERT INTO crm.engagement
            (id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
             entity_party_id, status, activated_at)
          VALUES
            (${e.id}, ${e.tenantId}, ${e.engagementLetterId}, ${e.engagementLetterLineId},
             ${e.partyId}, ${e.entityPartyId}, ${e.status}, ${e.activatedAt}::timestamptz)
          RETURNING id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
                    entity_party_id, status, activated_at, ends_on
        `;
        if (!row) throw new Error("engagement insert returned no row");
        created.push(toEngagement(row));
      }
      return { letter: toLetter(letter), engagements: created };
    });
  }

  async recordAdvance(
    tenantId: string,
    letterId: string,
    recordedByUserId: string,
    at: string,
  ): Promise<{ letter: EngagementLetter; released: readonly Engagement[] }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [letter] = await db<LetterRow[]>`
        UPDATE crm.engagement_letter
           SET advance_recorded_at = ${at}::timestamptz, advance_recorded_by = ${recordedByUserId}
         WHERE id = ${letterId} AND advance_recorded_at IS NULL
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                  jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
                  advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
                  signature_method, signature_reference, signed_content_hash, withdrawn_at
      `;
      // Same trick as the signature: `advance_recorded_at IS NULL` is the lock,
      // so two clicks cannot both release the engagements.
      if (!letter) {
        throw new Error(`the advance on engagement letter ${letterId} was already recorded`);
      }

      const released = await db<EngagementRow[]>`
        UPDATE crm.engagement
           SET status = 'active', activated_at = ${at}::timestamptz
         WHERE engagement_letter_id = ${letterId} AND status = 'pending_advance'
        RETURNING id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
                  entity_party_id, status, activated_at, ends_on
      `;
      return { letter: toLetter(letter), released: released.map(toEngagement) };
    });
  }

  async listEngagements(tenantId: string, letterId: string): Promise<readonly Engagement[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<EngagementRow[]>`
        SELECT id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
               entity_party_id, status, activated_at, ends_on
        FROM crm.engagement WHERE engagement_letter_id = ${letterId}
        ORDER BY created_at
      `;
      return rows.map(toEngagement);
    });
  }
}
