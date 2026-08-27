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
}

function toTenant(r: TenantRow): Tenant {
  return { id: r.id, slug: r.slug, name: r.name, status: r.status };
}

export class PostgresTenantRepository implements TenantRepository {
  constructor(private readonly app: Db) {}

  async create(t: NewTenant): Promise<Tenant> {
    const [row] = await this.app<TenantRow[]>`
      INSERT INTO tenancy.tenant (id, slug, name)
      VALUES (${t.id}, ${t.slug}, ${t.name})
      RETURNING id, slug, name, status
    `;
    if (!row) throw new Error("tenant insert returned no row");
    return toTenant(row);
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const [row] = await this.app<TenantRow[]>`
      SELECT id, slug, name, status FROM tenancy.tenant WHERE slug = ${slug}
    `;
    return row ? toTenant(row) : null;
  }

  async findById(id: string): Promise<Tenant | null> {
    const [row] = await this.app<TenantRow[]>`
      SELECT id, slug, name, status FROM tenancy.tenant WHERE id = ${id}
    `;
    return row ? toTenant(row) : null;
  }
}
