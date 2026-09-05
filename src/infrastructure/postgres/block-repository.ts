// The prose blocks, in Postgres (G1.7) — the firm's STANDARD set and what one
// DOCUMENT says.
//
// Two classes rather than two more `implements` on PostgresDocumentRepository,
// and the reason is not tidiness: both ports declare `list`, `find`, `add` and
// `edit`, and one class cannot carry three meanings of `list`. That collision
// is the design telling the truth — a preference row, a reference series and a
// prose line are three concerns, and TypeScript refused to let them share a
// surface. One file per concern, named after the concern.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { BlockKind, DocumentBlock, StandardBlock } from "../../domain/document/model";
import { isBlockKind } from "../../domain/document/model";
import { DocumentBlockFrozen } from "../../domain/document/errors";
import type {
  BlockOwner,
  DocumentBlockEdit,
  DocumentBlockRepository,
  NewDocumentBlock,
  NewStandardBlock,
  StandardBlockEdit,
  StandardBlockRepository,
} from "../../usecase/document/ports";

/**
 * `kind` is read back through the domain's guard rather than cast.
 *
 * The column has a CHECK naming the same three values, so this can only throw
 * if the two vocabularies have drifted — which is exactly the moment a silent
 * cast would put a value the rest of the code cannot handle into a typed field.
 * An adapter turns the outside world into our types AT THE DOOR.
 */
function toBlockKind(raw: string, table: string): BlockKind {
  if (!isBlockKind(raw)) {
    throw new Error(
      `${table} holds kind ${JSON.stringify(raw)}, which is not a BlockKind. The CHECK ` +
        `constraint and domain/document/model.ts have drifted apart.`,
    );
  }
  return raw;
}

interface StandardBlockRow {
  id: string;
  tenant_id: string;
  kind: string;
  body: string;
  is_heading: boolean;
  sort_order: number;
  jurisdiction: string | null;
  is_active: boolean;
}

function toStandardBlock(r: StandardBlockRow): StandardBlock {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: toBlockKind(r.kind, "crm.standard_document_block"),
    body: r.body,
    isHeading: r.is_heading,
    sortOrder: r.sort_order,
    jurisdiction: r.jurisdiction,
    isActive: r.is_active,
  };
}

const STANDARD_COLUMNS =
  "id, tenant_id, kind, body, is_heading, sort_order, jurisdiction, is_active";

export class PostgresStandardBlockRepository implements StandardBlockRepository {
  constructor(private readonly app: Db) {}

  async list(tenantId: string): Promise<readonly StandardBlock[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<StandardBlockRow[]>`
        SELECT ${db.unsafe(STANDARD_COLUMNS)}
        FROM crm.standard_document_block
        -- Retired rows INCLUDED. The screen that maintains this set has to show
        -- what the firm stopped printing, and "where did this line on a letter
        -- come from" has to resolve for a document issued while it was live.
        -- The filtering that matters is blocksFor() in the domain, at COPY time.
        ORDER BY kind, sort_order, id
      `;
      return rows.map(toStandardBlock);
    });
  }

  async find(tenantId: string, id: string): Promise<StandardBlock | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<StandardBlockRow[]>`
        SELECT ${db.unsafe(STANDARD_COLUMNS)}
        FROM crm.standard_document_block WHERE id = ${id}
      `;
      return row ? toStandardBlock(row) : null;
    });
  }

  async add(b: NewStandardBlock): Promise<StandardBlock> {
    return withTenant(this.app, b.tenantId, async (db) => {
      const [row] = await db<StandardBlockRow[]>`
        INSERT INTO crm.standard_document_block
          (id, tenant_id, kind, body, is_heading, sort_order, jurisdiction)
        VALUES (${b.id}, ${b.tenantId}, ${b.kind}, ${b.body}, ${b.isHeading}, ${b.sortOrder},
                ${b.jurisdiction})
        RETURNING ${db.unsafe(STANDARD_COLUMNS)}
      `;
      if (!row) throw new Error("standard document block insert returned no row");
      return toStandardBlock(row);
    });
  }

  async edit(tenantId: string, id: string, e: StandardBlockEdit): Promise<StandardBlock> {
    return withTenant(this.app, tenantId, async (db) => {
      // COALESCE on the PARAMETER, so an absent field keeps what is stored.
      // `jurisdiction` cannot be written that way and takes a flag instead:
      // setting it back to NULL means "print this everywhere", which is a real
      // edit and is indistinguishable from "unchanged" under COALESCE. That
      // distinction is the whole point of the column.
      const [row] = await db<StandardBlockRow[]>`
        UPDATE crm.standard_document_block
           SET body         = COALESCE(${e.body ?? null}, body),
               is_heading   = COALESCE(${e.isHeading ?? null}, is_heading),
               sort_order   = COALESCE(${e.sortOrder ?? null}, sort_order),
               jurisdiction = CASE WHEN ${e.jurisdiction !== undefined}
                                   THEN ${e.jurisdiction ?? null}::text
                                   ELSE jurisdiction END,
               is_active    = COALESCE(${e.isActive ?? null}, is_active)
         WHERE id = ${id}
        RETURNING ${db.unsafe(STANDARD_COLUMNS)}
      `;
      if (!row) throw new Error(`standard document block ${id} vanished during update`);
      return toStandardBlock(row);
    });
  }
}

interface DocumentBlockRow {
  id: string;
  tenant_id: string;
  kind: string;
  body: string;
  is_heading: boolean;
  sort_order: number;
  source_id: string | null;
  is_edited: boolean;
}

function toDocumentBlock(r: DocumentBlockRow): DocumentBlock {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: toBlockKind(r.kind, "crm.document_block"),
    body: r.body,
    isHeading: r.is_heading,
    sortOrder: r.sort_order,
    sourceId: r.source_id,
    isEdited: r.is_edited,
  };
}

// `is_edited` is DERIVED in the projection rather than stored: the only UPDATE
// this table takes is an edit, and `set_updated_at` fires on it. A stored flag
// would be a second place for the same fact to live, and the one that goes
// stale is always the copy.
/**
 * SQLSTATE 23001, `restrict_violation` — what `crm.refuse_signed_child_change()`
 * raises on this table and nothing else on these statements can.
 *
 * Matching the CODE rather than the message keeps the translation independent
 * of the wording, the same way `isArchiveRefusal` does for the party guard. The
 * refusal is not written here: the trigger is what holds against an import, an
 * agent or a psql session, and this only puts our own sentence round it.
 *
 * Without this the three block routes documented a 409 and answered 500. Nobody
 * had found it, because until a screen called them nothing ever did.
 */
function asFrozen(err: unknown): never {
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23001") {
    throw new DocumentBlockFrozen();
  }
  throw err;
}

const BLOCK_COLUMNS =
  "id, tenant_id, kind, body, is_heading, sort_order, source_id, " +
  "(updated_at > created_at) AS is_edited";

export class PostgresDocumentBlockRepository implements DocumentBlockRepository {
  constructor(private readonly app: Db) {}

  async list(tenantId: string, owner: BlockOwner): Promise<readonly DocumentBlock[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<DocumentBlockRow[]>`
        SELECT ${db.unsafe(BLOCK_COLUMNS)}
        FROM crm.document_block
        WHERE removed_at IS NULL
          AND ${owner.kind === "proposal" ? db`proposal_id` : db`engagement_letter_id`} = ${owner.id}
        -- (kind, sort_order, id) — total, so two lines the firm gave the same
        -- order print in a stable sequence rather than whatever the planner
        -- returned that afternoon. sort_order is deliberately not unique.
        ORDER BY kind, sort_order, id
      `;
      return rows.map(toDocumentBlock);
    });
  }

  async find(tenantId: string, id: string): Promise<DocumentBlock | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<DocumentBlockRow[]>`
        SELECT ${db.unsafe(BLOCK_COLUMNS)}
        FROM crm.document_block WHERE id = ${id} AND removed_at IS NULL
      `;
      return row ? toDocumentBlock(row) : null;
    });
  }

  /**
   * The copy, in ONE statement.
   *
   * A document carrying half the firm's exclusions is worse than one carrying
   * none: the second is obviously unfinished, the first reads as a deliberate
   * list somebody chose. One multi-row INSERT makes that structural rather than
   * careful.
   */
  async addMany(blocks: readonly NewDocumentBlock[]): Promise<readonly DocumentBlock[]> {
    const first = blocks[0];
    if (first === undefined) return [];
    return withTenant(this.app, first.tenantId, async (db) => {
      const rows = await db<DocumentBlockRow[]>`
        INSERT INTO crm.document_block ${db(
          blocks.map((b) => ({
            id: b.id,
            tenant_id: b.tenantId,
            proposal_id: b.owner.kind === "proposal" ? b.owner.id : null,
            engagement_letter_id: b.owner.kind === "engagement_letter" ? b.owner.id : null,
            kind: b.kind,
            body: b.body,
            is_heading: b.isHeading,
            sort_order: b.sortOrder,
            source_id: b.sourceId,
          })),
        )}
        RETURNING ${db.unsafe(BLOCK_COLUMNS)}
      `.catch(asFrozen);
      return rows.map(toDocumentBlock);
    });
  }

  async add(b: NewDocumentBlock): Promise<DocumentBlock> {
    const [saved] = await this.addMany([b]);
    if (!saved) throw new Error("document block insert returned no row");
    return saved;
  }

  async edit(tenantId: string, id: string, e: DocumentBlockEdit): Promise<DocumentBlock> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<DocumentBlockRow[]>`
        UPDATE crm.document_block
           SET body       = COALESCE(${e.body ?? null}, body),
               is_heading = COALESCE(${e.isHeading ?? null}, is_heading),
               sort_order = COALESCE(${e.sortOrder ?? null}, sort_order)
         WHERE id = ${id} AND removed_at IS NULL
        RETURNING ${db.unsafe(BLOCK_COLUMNS)}
      `.catch(asFrozen);
      if (!row) throw new Error(`document block ${id} vanished during update`);
      return toDocumentBlock(row);
    });
  }

  /** `removed_at`, because `bib_app` holds no DELETE grant on any table in this
   *  database. The predicate makes a second removal a no-op rather than a
   *  second write to a row already struck off. */
  async remove(tenantId: string, id: string): Promise<void> {
    await withTenant(
      this.app,
      tenantId,
      (db) =>
        db`
          UPDATE crm.document_block SET removed_at = now()
          WHERE id = ${id} AND removed_at IS NULL
        `.catch(asFrozen),
    );
  }
}
