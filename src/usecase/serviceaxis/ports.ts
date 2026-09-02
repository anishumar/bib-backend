// The ports this use case needs from the world — the seams. Interfaces are owned
// by the use case that needs them (never a shared top-level ports package),
// stated in our vocabulary. Adapters in infrastructure/ implement them.
import type { ServiceAxis, ServiceAxisKind, WorkSplitAxis } from "../../domain/serviceaxis/model";

export interface NewServiceAxis {
  readonly id: string;
  readonly tenantId: string;
  readonly axis: ServiceAxisKind;
  /** Normalised and validated by the service; the adapter stores it as given. */
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
}

/** What an update may change. Both optional and independently applied, so
 *  renaming a Dept and reordering it are one call or two, as the caller likes.
 *
 *  `code` is deliberately absent: it is what every service body joins on, and
 *  those bodies may be published and therefore frozen. Changing a code would
 *  orphan them silently. A firm that wants a different code adds a row and
 *  retires the old one, which leaves the history readable — which is the point. */
export interface ServiceAxisPatch {
  readonly name?: string | undefined;
  readonly sortOrder?: number | undefined;
}

export interface ServiceAxisRepository {
  /** One whole list, RETIRED rows included — an admin needs to see what the firm
   *  stopped using and be able to bring it back. Ordering is the domain's job
   *  (`axisOrder`), not the query's. */
  list(tenantId: string, axis: ServiceAxisKind): Promise<readonly ServiceAxis[]>;
  /** Both lists in one round trip. What the catalogue screen needs to render two
   *  pickers, and what the config write path checks against. */
  listAll(tenantId: string): Promise<readonly ServiceAxis[]>;
  findById(tenantId: string, id: string): Promise<ServiceAxis | null>;
  /** By the firm's own handle — how a picker, an importer and the config write
   *  path look one up. */
  findByCode(
    tenantId: string,
    axis: ServiceAxisKind,
    code: string,
  ): Promise<ServiceAxis | null>;
  create(row: NewServiceAxis): Promise<ServiceAxis>;
  update(tenantId: string, id: string, patch: ServiceAxisPatch): Promise<ServiceAxis>;
  /**
   * Stop filing new work under a Dept or team, or start again.
   *
   * Never a delete. A Dept that existed in 2026 is part of why a service was
   * filed where it was filed and why a client had the SPOC they had, so it stays
   * readable forever — the same distinction `staff_grade.is_active` carries.
   */
  setActive(tenantId: string, id: string, isActive: boolean): Promise<ServiceAxis>;
}

/**
 * How this firm cuts one client's work up.
 *
 * A single scalar on the tenant rather than a row in the configuration registry,
 * for the reason `tenant.firm_signatory_user_id` states: it is freely changeable
 * and changing it RESTATES NOTHING. Jobs already created keep the rows they
 * have; the next engagement is split the new way. There is nothing to pin.
 */
export interface WorkSplitSetting {
  read(tenantId: string): Promise<WorkSplitAxis>;
  write(tenantId: string, axis: WorkSplitAxis): Promise<void>;
}

/**
 * Which calendar this firm's months and days are cut on (0071).
 *
 * A column on `tenancy.tenant`, like `WorkSplitSetting` next to it and for the
 * same reason: freely changeable, and nobody will ever ask what it said last
 * March. The value is validated by a TRIGGER as well as by the service, so an
 * import cannot write a zone the digest would then throw on.
 */
export interface TimeZoneSetting {
  read(tenantId: string): Promise<string>;
  write(tenantId: string, timeZone: string): Promise<string>;
}
