// Postgres adapter for the global identity table. GLOBAL (identity above
// tenant), so it runs on the app pool with no tenant scope.
import type { Db } from "../../db/pool";
import type { UserAccount } from "../../domain/tenancy/model";
import type { NewUser, UserRepository } from "../../usecase/tenancy/ports";

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  status: "active" | "disabled";
}

function toUser(r: UserRow): UserAccount {
  return { id: r.id, email: r.email, displayName: r.display_name, status: r.status };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly app: Db) {}

  async create(u: NewUser): Promise<UserAccount> {
    const [row] = await this.app<UserRow[]>`
      INSERT INTO tenancy.user_account (id, email, display_name)
      VALUES (${u.id}, ${u.email}, ${u.displayName ?? null})
      RETURNING id, email::text AS email, display_name, status
    `;
    if (!row) throw new Error("user insert returned no row");
    return toUser(row);
  }

  async findByEmail(email: string): Promise<UserAccount | null> {
    const [row] = await this.app<UserRow[]>`
      SELECT id, email::text AS email, display_name, status
      FROM tenancy.user_account WHERE email = ${email}
    `;
    return row ? toUser(row) : null;
  }

  async findById(id: string): Promise<UserAccount | null> {
    const [row] = await this.app<UserRow[]>`
      SELECT id, email::text AS email, display_name, status
      FROM tenancy.user_account WHERE id = ${id}
    `;
    return row ? toUser(row) : null;
  }
}
