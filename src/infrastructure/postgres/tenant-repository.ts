// Postgres adapter for the tenant registry (a GLOBAL table — not tenant-scoped,
// so no resolver; it runs on the app pool directly). `implements` is the
// compile-time port assertion: add a method to the port and this file stops
// compiling here, with a clear message, instead of at some call site later.
import type { Db } from "../../db/pool";
import type { Tenant } from "../../domain/tenancy/model";
import type { NewTenant, TenantRepository } from "../../usecase/tenancy/ports";

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended";
  reporting_currency: string;
  firm_signatory_user_id: string | null;
  firm_signatory_title: string | null;
}

function toTenant(r: TenantRow): Tenant {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    reportingCurrency: r.reporting_currency,
    firmSignatoryUserId: r.firm_signatory_user_id,
    firmSignatoryTitle: r.firm_signatory_title,
  };
}

export class PostgresTenantRepository implements TenantRepository {
  constructor(private readonly app: Db) {}

  async create(t: NewTenant): Promise<Tenant> {
    const [row] = await this.app<TenantRow[]>`
      INSERT INTO tenancy.tenant (id, slug, name, reporting_currency)
      VALUES (${t.id}, ${t.slug}, ${t.name}, ${t.reportingCurrency})
      RETURNING id, slug, name, status, reporting_currency,
                firm_signatory_user_id, firm_signatory_title
    `;
    if (!row) throw new Error("tenant insert returned no row");
    return toTenant(row);
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const [row] = await this.app<TenantRow[]>`
      SELECT id, slug, name, status, reporting_currency,
             firm_signatory_user_id, firm_signatory_title
      FROM tenancy.tenant WHERE slug = ${slug}
    `;
    return row ? toTenant(row) : null;
  }

  async findById(id: string): Promise<Tenant | null> {
    const [row] = await this.app<TenantRow[]>`
      SELECT id, slug, name, status, reporting_currency,
             firm_signatory_user_id, firm_signatory_title
      FROM tenancy.tenant WHERE id = ${id}
    `;
    return row ? toTenant(row) : null;
  }

  /**
   * `TenantStanding` — is this firm still open?
   *
   * A single column off the primary key, deliberately NOT `findById`: this runs
   * on every authenticated request, and reading the whole row to look at one
   * string would carry the signatory and the currency along with it for nothing.
   *
   * A row that does not exist answers FALSE, which is the fail-closed
   * direction. It is not a state the product reaches — sessions point at real
   * firms — and if it ever does, refusing is the right answer.
   */
  async isOpen(tenantId: string): Promise<boolean> {
    const [row] = await this.app<{ status: string }[]>`
      SELECT status FROM tenancy.tenant WHERE id = ${tenantId}
    `;
    return row?.status === "active";
  }

  /**
   * Suspend a firm, or let it back in.
   *
   * The writer the column never had. Before this, `status` was set at insert
   * and by nothing else — so an operator could read the value, believe it meant
   * something, and be wrong in both directions. On /internal because it is a
   * PLATFORM act: a firm cannot suspend itself, and no session should be able
   * to reach it.
   */
  async setStatus(tenantId: string, status: "active" | "suspended"): Promise<Tenant | null> {
    const [row] = await this.app<TenantRow[]>`
      UPDATE tenancy.tenant SET status = ${status}
       WHERE id = ${tenantId}
      RETURNING id, slug, name, status, reporting_currency,
                firm_signatory_user_id, firm_signatory_title
    `;
    return row ? toTenant(row) : null;
  }

  /** Both columns in one statement, because the constraint holds them together
   *  and two statements would let a crash leave a name with no capacity. */
  async setFirmSignatory(tenantId: string, userId: string, title: string): Promise<Tenant> {
    const [row] = await this.app<TenantRow[]>`
      UPDATE tenancy.tenant
         SET firm_signatory_user_id = ${userId}, firm_signatory_title = ${title}
       WHERE id = ${tenantId}
      RETURNING id, slug, name, status, reporting_currency,
                firm_signatory_user_id, firm_signatory_title
    `;
    if (!row) throw new Error(`tenant ${tenantId} vanished while naming its signatory`);
    return toTenant(row);
  }
}
