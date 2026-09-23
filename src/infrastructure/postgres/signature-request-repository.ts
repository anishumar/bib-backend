// A letter's signature request (0080), in Postgres. `withTenant` throughout —
// this is the firm's own machinery, and no portal route reads it.
//
// ── THE CLAIM IS ONE STATEMENT ───────────────────────────────────────────────
//
// `claim` is an UPDATE with the whole condition in its WHERE, so two callers
// racing for the same request cannot both win: Postgres serialises the row and
// the second sees the first's `claimed_at`. Reading first and writing second
// would be a window in which both send the client an envelope.
//
// Every instant leaves through `isoInstant` (T6.10), never `::text`.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  NewSignatureRequest,
  SignatureOutcome,
  SignatureRequest,
  SignatureRequestRepository,
} from "../../usecase/engagement/ports";
import { isoInstant } from "./instant";

interface Row {
  id: string;
  tenant_id: string;
  engagement_letter_id: string;
  provider: string;
  signer_name: string;
  signer_email: string;
  requested_by: string | null;
  envelope_id: string | null;
  raised_at: string | null;
  last_failure: string | null;
  attempts: number;
  outcome: SignatureOutcome | null;
  settled_at: string | null;
  copies_filed_at: string | null;
  created_at: string;
}

function columns(): string {
  return [
    "id",
    "tenant_id",
    "engagement_letter_id",
    "provider",
    "signer_name",
    "signer_email",
    "requested_by",
    "envelope_id",
    isoInstant("raised_at", "raised_at"),
    "last_failure",
    "attempts",
    "outcome",
    isoInstant("settled_at", "settled_at"),
    isoInstant("copies_filed_at", "copies_filed_at"),
    isoInstant("created_at", "created_at"),
  ].join(", ");
}

function toRequest(r: Row): SignatureRequest {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    letterId: r.engagement_letter_id,
    provider: r.provider,
    signer: { name: r.signer_name, email: r.signer_email },
    requestedBy: r.requested_by,
    envelopeId: r.envelope_id,
    raisedAt: r.raised_at,
    lastFailure: r.last_failure,
    attempts: r.attempts,
    outcome: r.outcome,
    settledAt: r.settled_at,
    copiesFiledAt: r.copies_filed_at,
    createdAt: r.created_at,
  };
}

export class PostgresSignatureRequestRepository implements SignatureRequestRepository {
  constructor(private readonly app: Db) {}

  async open(request: NewSignatureRequest): Promise<SignatureRequest> {
    return withTenant(this.app, request.tenantId, async (db) => {
      // A second send of the same letter — the first failed half way — takes
      // the new signer while no envelope exists, and changes nothing once one
      // does: the WHERE on the conflict branch makes the RETURNING empty, and
      // the row is then read as it stands.
      const [row] = await db<Row[]>`
        INSERT INTO crm.letter_signature_request
          (id, tenant_id, engagement_letter_id, provider, signer_name, signer_email, requested_by)
        VALUES (${request.id}, ${request.tenantId}, ${request.letterId}, ${request.provider},
                ${request.signer.name}, ${request.signer.email}, ${request.requestedBy})
        ON CONFLICT (tenant_id, engagement_letter_id) DO UPDATE
          SET signer_name  = EXCLUDED.signer_name,
              signer_email = EXCLUDED.signer_email,
              requested_by = EXCLUDED.requested_by,
              provider     = EXCLUDED.provider
          WHERE crm.letter_signature_request.envelope_id IS NULL
        RETURNING ${db.unsafe(columns())}
      `;
      if (row) return toRequest(row);
      const [existing] = await db<Row[]>`
        SELECT ${db.unsafe(columns())}
        FROM crm.letter_signature_request
        WHERE engagement_letter_id = ${request.letterId}
      `;
      if (!existing) throw new Error(`signature request for letter ${request.letterId} vanished`);
      return toRequest(existing);
    });
  }

  async findForLetter(tenantId: string, letterId: string): Promise<SignatureRequest | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<Row[]>`
        SELECT ${db.unsafe(columns())}
        FROM crm.letter_signature_request
        WHERE engagement_letter_id = ${letterId}
      `;
      return row ? toRequest(row) : null;
    });
  }

  async claim(
    tenantId: string,
    requestId: string,
    at: string,
    staleBefore: string,
  ): Promise<SignatureRequest | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<Row[]>`
        UPDATE crm.letter_signature_request
           SET claimed_at = ${at}::timestamptz,
               attempts   = attempts + 1
         WHERE id = ${requestId}
           AND envelope_id IS NULL
           AND outcome IS NULL
           AND (claimed_at IS NULL OR claimed_at < ${staleBefore}::timestamptz)
        RETURNING ${db.unsafe(columns())}
      `;
      return row ? toRequest(row) : null;
    });
  }

  async recordRaised(
    tenantId: string,
    requestId: string,
    envelopeId: string,
    at: string,
  ): Promise<SignatureRequest> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<Row[]>`
        UPDATE crm.letter_signature_request
           SET envelope_id  = ${envelopeId},
               raised_at    = ${at}::timestamptz,
               claimed_at   = NULL,
               last_failure = NULL
         WHERE id = ${requestId}
        RETURNING ${db.unsafe(columns())}
      `;
      if (!row) throw new Error(`no signature request ${requestId} to record envelope ${envelopeId} on`);
      return toRequest(row);
    });
  }

  async recordFailure(
    tenantId: string,
    requestId: string,
    failure: string,
  ): Promise<SignatureRequest> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<Row[]>`
        UPDATE crm.letter_signature_request
           SET last_failure = ${failure},
               claimed_at   = NULL
         WHERE id = ${requestId}
        RETURNING ${db.unsafe(columns())}
      `;
      if (!row) throw new Error(`no signature request ${requestId} to record a failure on`);
      return toRequest(row);
    });
  }

  async listAwaiting(tenantId: string): Promise<readonly SignatureRequest[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<Row[]>`
        SELECT ${db.unsafe(columns())}
        FROM crm.letter_signature_request
        WHERE outcome IS NULL AND envelope_id IS NOT NULL
        ORDER BY created_at
      `;
      return rows.map(toRequest);
    });
  }

  async settle(
    tenantId: string,
    requestId: string,
    outcome: SignatureOutcome,
    at: string,
  ): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE crm.letter_signature_request
           SET outcome = ${outcome}, settled_at = ${at}::timestamptz
         WHERE id = ${requestId} AND outcome IS NULL
      `;
    });
  }

  async listUnfiled(tenantId: string): Promise<readonly SignatureRequest[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<Row[]>`
        SELECT ${db.unsafe(columns())}
        FROM crm.letter_signature_request
        WHERE outcome = 'completed' AND copies_filed_at IS NULL
        ORDER BY settled_at
      `;
      return rows.map(toRequest);
    });
  }

  async recordCopiesFiled(tenantId: string, requestId: string, at: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE crm.letter_signature_request
           SET copies_filed_at = ${at}::timestamptz
         WHERE id = ${requestId} AND copies_filed_at IS NULL
      `;
    });
  }
}
