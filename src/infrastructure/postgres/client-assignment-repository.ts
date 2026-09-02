// Postgres adapter for client ownership (G3.2). Every read and write goes
// through withTenant — an assignment is one firm's arrangement about one of its
// own clients, so there is no identity-mode path here at all.
//
// Dates are selected `::text`. postgres.js parses a `date` column into a JS
// `Date`, which is an INSTANT and moves the day for anybody east or west of
// UTC — and a handover is a calendar fact in the firm's own office. The whole
// domain compares these as ISO strings; the same cast `relationship-repository`
// makes, for the same reason.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  AssignmentRole,
  ClientAssignment,
  ClientAssignmentRecord,
  OwnedClient,
} from "../../domain/clientassignment/model";
import { isAssignmentRole } from "../../domain/clientassignment/model";
import type {
  ClientAssignmentRepository,
  HandoverClose,
  NewClientAssignment,
} from "../../usecase/clientassignment/ports";
import type { SpocDirectory } from "../../usecase/workitem/ports";
import type { SpocCandidate } from "../../domain/workitem/model";
import { isoInstant } from "./instant";

interface AssignmentRow {
  id: string;
  tenant_id: string;
  client_party_id: string;
  role: string;
  axis_id: string | null;
  user_id: string;
  valid_from: string;
  valid_to: string | null;
}

interface AssignmentRecordRow extends AssignmentRow {
  holder_email: string;
  holder_display_name: string | null;
  axis_axis: string | null;
  axis_code: string | null;
  axis_name: string | null;
  axis_is_active: boolean | null;
}

function toAssignment(r: AssignmentRow): ClientAssignment {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    clientPartyId: r.client_party_id,
    // The CHECK constraint guarantees this, so the cast states a fact the
    // database already enforces rather than hoping for one.
    role: r.role as AssignmentRole,
    axisId: r.axis_id,
    userId: r.user_id,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  };
}

/**
 * The axis columns arrive together or not at all — they come from one LEFT JOIN
 * that only matches when `axis_id` is set. Written as one guard rather than
 * four so a column added later cannot be forgotten here; `toMemberGrade` makes
 * the same move for the same reason.
 */
function toRecord(r: AssignmentRecordRow): ClientAssignmentRecord {
  return {
    assignment: toAssignment(r),
    holder: {
      userId: r.user_id,
      email: r.holder_email,
      displayName: r.holder_display_name,
    },
    axis:
      r.axis_id === null || r.axis_code === null
        ? null
        : {
            id: r.axis_id,
            axis: r.axis_axis ?? "",
            code: r.axis_code,
            name: r.axis_name ?? r.axis_code,
            isActive: r.axis_is_active ?? false,
          },
  };
}

const COLUMNS =
  "id, tenant_id, client_party_id, role, axis_id, user_id, " +
  "valid_from::text AS valid_from, valid_to::text AS valid_to";

/**
 * ONE adapter over `crm.client_assignment`, serving TWO ports.
 *
 * `ClientAssignmentRepository` is G3.2's own write and read side.
 * `SpocDirectory` is T3.1's single question — *who does this client talk to
 * about FRC work, on this day* — asked when a filing needs routing. Two
 * adapters over one table would eventually disagree about what "in force"
 * means, and here that would mean a filing routed to somebody whose handover
 * finished last week. The same arrangement `PostgresServiceAxisRepository` and
 * `PostgresConfigRepository` already have.
 */
export class PostgresClientAssignmentRepository
  implements ClientAssignmentRepository, SpocDirectory
{
  constructor(private readonly app: Db) {}

  /**
   * Every assignment this client has ever had, holder and axis resolved.
   *
   * The join is in the QUERY and not a lookup per row: a read model carries
   * NAMES, not ids, or the screen fetches a person per line to render the
   * account team. This codebase has learnt that five times.
   */
  async listForClient(
    tenantId: string,
    clientPartyId: string,
  ): Promise<readonly ClientAssignmentRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<AssignmentRecordRow[]>`
        SELECT a.id, a.tenant_id, a.client_party_id, a.role, a.axis_id, a.user_id,
               a.valid_from::text AS valid_from, a.valid_to::text AS valid_to,
               u.email::text AS holder_email, u.display_name AS holder_display_name,
               x.axis AS axis_axis, x.code AS axis_code, x.name AS axis_name,
               x.is_active AS axis_is_active
        FROM crm.client_assignment a
        JOIN tenancy.user_account u ON u.id = a.user_id
        -- The tenant predicate is repeated even though RLS is on: a join is not
        -- the thing the policy guards against here, and stating it keeps the
        -- query honest if this is ever read outside a tenant transaction.
        LEFT JOIN tenancy.service_axis x
               ON x.id = a.axis_id AND x.tenant_id = a.tenant_id
        WHERE a.client_party_id = ${clientPartyId}
        ORDER BY a.valid_from DESC, a.role
      `;
      return rows.map(toRecord);
    });
  }

  async findById(tenantId: string, assignmentId: string): Promise<ClientAssignment | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<AssignmentRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM crm.client_assignment WHERE id = ${assignmentId}
      `;
      return row ? toAssignment(row) : null;
    });
  }

  /**
   * Not already over by `onDate`, by the same half-open rule the domain uses —
   * `valid_to` is the first day NOT in force, so `>` and not `>=`.
   *
   * The date comes from the CALLER and never from `CURRENT_DATE`. The database
   * server's day is UTC's; the firm's day is its own, and for five and a half
   * hours every morning in India those are different dates. A row starting on
   * the firm's today would be invisible to this query, the service would think
   * there was no incumbent, and the exclusion constraint would refuse the
   * insert as an unexplained 500.
   */
  async listOpenForClient(
    tenantId: string,
    clientPartyId: string,
    role: AssignmentRole,
    onDate: string,
  ): Promise<readonly ClientAssignment[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<AssignmentRow[]>`
        SELECT ${db.unsafe(COLUMNS)}
        FROM crm.client_assignment
        WHERE client_party_id = ${clientPartyId}
          AND role = ${role}
          AND (valid_to IS NULL OR valid_to > ${onDate}::date)
        ORDER BY valid_from DESC
      `;
      return rows.map(toAssignment);
    });
  }

  /**
   * The insert, and the handover's close, in ONE transaction.
   *
   * `withTenant` opens the transaction, so both statements commit or neither
   * does. The order is forced: the exclusion constraint refuses the incoming
   * key-manager row until the outgoing one is closed. Splitting these into two
   * calls would mean a failed insert leaves a client with nobody in charge.
   */
  async create(
    row: NewClientAssignment,
    handover: HandoverClose | null,
  ): Promise<ClientAssignment> {
    return withTenant(this.app, row.tenantId, async (db) => {
      if (handover) {
        const closed = await db`
          UPDATE crm.client_assignment
          SET valid_to = ${handover.validTo}::date
          WHERE id = ${handover.assignmentId} AND valid_to IS NULL
          RETURNING id
        `;
        // Somebody else closed or replaced the incumbent between this
        // request's read and its write. Aborting the transaction is the
        // correct answer: carrying on would insert a second key manager the
        // exclusion constraint is about to refuse anyway, with a message
        // nobody can act on.
        if (closed.length === 0) {
          throw new Error(
            `client assignment ${handover.assignmentId} was already closed by another ` +
              `write; the handover was not applied and nothing was recorded`,
          );
        }
      }

      const [created] = await db<AssignmentRow[]>`
        INSERT INTO crm.client_assignment
          (id, tenant_id, client_party_id, role, axis_id, user_id, valid_from)
        VALUES
          (${row.id}, ${row.tenantId}, ${row.clientPartyId}, ${row.role},
           ${row.axisId}, ${row.userId}, ${row.validFrom}::date)
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!created) throw new Error("client_assignment insert returned no row");
      return toAssignment(created);
    });
  }

  async end(
    tenantId: string,
    assignmentId: string,
    validTo: string,
  ): Promise<ClientAssignment> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<AssignmentRow[]>`
        UPDATE crm.client_assignment
        SET valid_to = ${validTo}::date
        WHERE id = ${assignmentId} AND valid_to IS NULL
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) {
        throw new Error(
          `client assignment ${assignmentId} vanished or was closed between the read and ` +
            `the write`,
        );
      }
      return toAssignment(row);
    });
  }

  /**
   * One person's book — one row per CLIENT, with the roles collected.
   *
   * Aggregated in SQL rather than in the service, because the alternative is
   * reading every assignment the person holds and grouping them in memory to
   * render a list that is already sorted by the database. `archived_at` rides
   * along so the screen can mark a client the firm has put away rather than
   * dropping it: somebody still holds it, and hiding that would make the book
   * look smaller than the record says.
   */
  async listForUser(
    tenantId: string,
    userId: string,
    onDate: string,
  ): Promise<readonly OwnedClient[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        {
          client_party_id: string;
          display_name: string;
          archived_at: string | null;
          roles: string[];
        }[]
      >`
        SELECT a.client_party_id,
               p.display_name,
               ${db.unsafe(isoInstant("p.archived_at", "archived_at"))},
               array_agg(DISTINCT a.role) AS roles
        FROM crm.client_assignment a
        JOIN core.party p ON p.id = a.client_party_id AND p.tenant_id = a.tenant_id
        WHERE a.user_id = ${userId}
          AND a.valid_from <= ${onDate}::date
          AND (a.valid_to IS NULL OR a.valid_to > ${onDate}::date)
        GROUP BY a.client_party_id, p.display_name, p.archived_at
        ORDER BY p.display_name
      `;
      return rows.map((r) => ({
        clientPartyId: r.client_party_id,
        displayName: r.display_name,
        archivedAt: r.archived_at,
        // The CHECK guarantees every value, so the filter is a type narrowing
        // rather than a validation — but it is written as one so an unknown
        // role arriving from a future migration is dropped instead of widening
        // the union by a cast.
        roles: r.roles.filter(isAssignmentRole),
      }));
    });
  }

  /**
   * Who the client talks to about ONE part of the work, on one day — T3.1's
   * routing read.
   *
   * A LIST, always. G3.2 deliberately allows more than one SPOC per Dept (leave
   * cover, a joint SPOC on a group, a fortnight's parallel handover), and what
   * to DO with two is `resolveAssignee`'s decision in the domain, not this
   * query's. Returning "the first one" here would bury a product rule in an
   * ORDER BY.
   *
   * Half-open, `[valid_from, valid_to)`, like every effective-dated read in
   * this product — so a handover that closes at D and opens at D returns
   * exactly one person on D, never two.
   *
   * `onDate` is the CALLER's calendar day and never `CURRENT_DATE`. The
   * database server's day is UTC's; the firm's is its own, and for five and a
   * half hours every morning in India those are different dates — a SPOC whose
   * term starts on the firm's today would be invisible to this query and the
   * filing would land in the unassigned queue for the rest of the morning.
   */
  async spocsFor(
    tenantId: string,
    clientPartyId: string,
    axisId: string,
    onDate: string,
  ): Promise<readonly SpocCandidate[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        { user_id: string; display_name: string | null; email: string }[]
      >`
        SELECT a.user_id, u.display_name, u.email::text AS email
        FROM crm.client_assignment a
        JOIN tenancy.user_account u ON u.id = a.user_id
        WHERE a.client_party_id = ${clientPartyId}
          AND a.role = 'spoc'
          AND a.axis_id = ${axisId}
          AND a.valid_from <= ${onDate}::date
          AND (a.valid_to IS NULL OR a.valid_to > ${onDate}::date)
        ORDER BY u.display_name, u.email
      `;
      return rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        email: r.email,
      }));
    });
  }
}
