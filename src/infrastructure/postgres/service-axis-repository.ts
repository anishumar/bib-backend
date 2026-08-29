// Postgres adapter for the firm's Depts and delivery teams (G2.4). Every read
// and write goes through withTenant — a Dept is meaningless outside the firm
// that named it, so there is no identity-mode path here at all.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  ServiceAxis,
  ServiceAxisKind,
  WorkSplitAxis,
} from "../../domain/serviceaxis/model";
import { isWorkSplitAxis } from "../../domain/serviceaxis/model";
import type {
  NewServiceAxis,
  ServiceAxisPatch,
  ServiceAxisRepository,
  WorkSplitSetting,
} from "../../usecase/serviceaxis/ports";
import type { AxisDirectory, KnownAxis } from "../../usecase/config/ports";
import type { AssignableAxisDirectory } from "../../usecase/clientassignment/ports";

interface AxisRow {
  id: string;
  tenant_id: string;
  axis: string;
  code: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

function toAxis(r: AxisRow): ServiceAxis {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    // The CHECK constraint guarantees this, so the cast states a fact the
    // database already enforces rather than hoping for one.
    axis: r.axis as ServiceAxisKind,
    code: r.code,
    name: r.name,
    // `integer` comes back as a JS number from postgres.js, but one that arrived
    // as a string would sort as one — coerced once, here at the door, the same
    // way `staff_grade.rank` is.
    sortOrder: Number(r.sort_order),
    isActive: r.is_active,
  };
}

const COLUMNS = "id, tenant_id, axis, code, name, sort_order, is_active";

/**
 * THREE ports over one table, the pattern the staff-grade repository already
 * uses.
 *
 * `ServiceAxisRepository` is this use case's own seam. `AxisDirectory` is the
 * CONFIG registry's — declared in config's vocabulary so the two use cases never
 * import each other, exactly as `RoleDirectory` lets tenancy ask the registry
 * what a role is without knowing what a config row looks like.
 * `AssignableAxisDirectory` is G3.2's, which needs one question answered: is
 * this Dept or delivery team the firm's, and does it still take new work? One
 * adapter because it is one table — two would eventually disagree, and a SPOC
 * would end up assigned to a Dept the picker never offered.
 *
 * The three `implements` are what makes the agreement a COMPILE error rather
 * than a discovery: if any port's shape drifts, this line fails, in one place.
 */
export class PostgresServiceAxisRepository
  implements ServiceAxisRepository, AxisDirectory, AssignableAxisDirectory
{
  constructor(private readonly app: Db) {}

  async list(tenantId: string, axis: ServiceAxisKind): Promise<readonly ServiceAxis[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Retired rows included: an admin needs to see what the firm stopped using
      // and be able to bring it back. Presentation order is the domain's job
      // (`axisOrder`); this is a stable order for deterministic reads, no more.
      const rows = await db<AxisRow[]>`
        SELECT ${db.unsafe(COLUMNS)}
        FROM tenancy.service_axis
        WHERE axis = ${axis}
        ORDER BY sort_order, name
      `;
      return rows.map(toAxis);
    });
  }

  async listAll(tenantId: string): Promise<readonly ServiceAxis[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<AxisRow[]>`
        SELECT ${db.unsafe(COLUMNS)}
        FROM tenancy.service_axis
        ORDER BY axis, sort_order, name
      `;
      return rows.map(toAxis);
    });
  }

  async findById(tenantId: string, id: string): Promise<ServiceAxis | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<AxisRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM tenancy.service_axis WHERE id = ${id}
      `;
      return row ? toAxis(row) : null;
    });
  }

  async findByCode(
    tenantId: string,
    axis: ServiceAxisKind,
    code: string,
  ): Promise<ServiceAxis | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<AxisRow[]>`
        SELECT ${db.unsafe(COLUMNS)}
        FROM tenancy.service_axis WHERE axis = ${axis} AND code = ${code}
      `;
      return row ? toAxis(row) : null;
    });
  }

  async create(row: NewServiceAxis): Promise<ServiceAxis> {
    return withTenant(this.app, row.tenantId, async (db) => {
      const [created] = await db<AxisRow[]>`
        INSERT INTO tenancy.service_axis (id, tenant_id, axis, code, name, sort_order)
        VALUES (${row.id}, ${row.tenantId}, ${row.axis}, ${row.code}, ${row.name},
                ${row.sortOrder})
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!created) throw new Error("service_axis insert returned no row");
      return toAxis(created);
    });
  }

  async update(
    tenantId: string,
    id: string,
    patch: ServiceAxisPatch,
  ): Promise<ServiceAxis> {
    return withTenant(this.app, tenantId, async (db) => {
      // COALESCE rather than the service pre-resolving absent fields: a patch
      // that omits a field means "leave it", and expressing that in SQL keeps
      // the two-round-trip read-then-write out of the use case, where it would
      // be a race the next caller has to remember.
      const [row] = await db<AxisRow[]>`
        UPDATE tenancy.service_axis
        SET name       = COALESCE(${patch.name ?? null}, name),
            sort_order = COALESCE(${patch.sortOrder ?? null}, sort_order)
        WHERE id = ${id}
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) throw new Error(`service_axis ${id} vanished between the read and the write`);
      return toAxis(row);
    });
  }

  async setActive(tenantId: string, id: string, isActive: boolean): Promise<ServiceAxis> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<AxisRow[]>`
        UPDATE tenancy.service_axis SET is_active = ${isActive}
        WHERE id = ${id}
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) throw new Error(`service_axis ${id} vanished between the read and the write`);
      return toAxis(row);
    });
  }

  // ── AxisDirectory (the config registry's seam) ──────────────────────────────

  /**
   * What the config registry needs to refuse a service body naming a Dept or
   * team the firm never defined: the firm's own codes, and whether each is still
   * in use.
   *
   * Both lists in ONE query, because a service body carries both fields and a
   * write checks both — two round trips would be two chances for the second to
   * see a different firm's state than the first.
   */
  async knownAxes(tenantId: string): Promise<readonly KnownAxis[]> {
    const rows = await this.listAll(tenantId);
    return rows.map((r) => ({
      axis: r.axis,
      code: r.code,
      isActive: r.isActive,
    }));
  }
}

/**
 * How this firm cuts a client's work up — a column on the tenant, not a row in
 * the configuration registry.
 *
 * `tenant.work_split_axis` is freely changeable and changing it RESTATES
 * NOTHING: jobs already created keep the rows they have, and the next engagement
 * is split the new way. That is the same argument `firm_signatory_user_id` (0022)
 * makes for being a column, and the opposite of `reporting_currency`, which is a
 * column because it must NEVER change.
 */
export class PostgresWorkSplitSetting implements WorkSplitSetting {
  constructor(private readonly app: Db) {}

  async read(tenantId: string): Promise<WorkSplitAxis> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ work_split_axis: string }[]>`
        SELECT work_split_axis FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      // A tenant the caller cannot see reads as `none` rather than throwing:
      // this is a SETTING, its absence is a real answer, and the alternative is
      // a read that fails differently depending on RLS context. The column is
      // NOT NULL with a default, so the only path here is "no such row".
      if (!row) return "none";
      return isWorkSplitAxis(row.work_split_axis) ? row.work_split_axis : "none";
    });
  }

  async write(tenantId: string, axis: WorkSplitAxis): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      const rows = await db`
        UPDATE tenancy.tenant SET work_split_axis = ${axis} WHERE id = ${tenantId}
        RETURNING id
      `;
      if (rows.length === 0) {
        throw new Error(`tenant ${tenantId} vanished between the read and the write`);
      }
    });
  }
}
