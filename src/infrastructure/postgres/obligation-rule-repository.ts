// Postgres adapter for the compliance RULES (T3.2) — templates, their
// exceptions, and the firm's own words for where an obligation has got to.
//
// Every read and write goes through `withTenant`: a firm's rules are its own,
// so there is no identity-mode path here at all.
//
// ── THE DUE RULE IS FOUR COLUMNS AND ONE OBJECT ────────────────────────────
//
// `obligation_due_rule_chk` (0052) guarantees that exactly one shape is present
// on any row, so `toDueRule` can read the columns without defending itself —
// and a null `due_rule` maps to a null object rather than to a half-built one,
// which is what lets the domain's `coverageOf` say "needs a formula" instead of
// producing a wrong date.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  DueRule,
  DueRuleException,
  ObligationState,
  ObligationTemplate,
} from "../../domain/obligation/model";
import type {
  NewException,
  NewObligationState,
  NewObligationTemplate,
  ObligationExceptionRepository,
  ObligationStateRepository,
  ObligationTemplateRepository,
  TemplatePatch,
  TemplateRecord,
} from "../../usecase/obligation/ports";

interface TemplateRow {
  id: string;
  tenant_id: string;
  jurisdiction: string;
  entity_type: string | null;
  service_entry_id: string | null;
  module: string | null;
  name: string;
  authority: string | null;
  recurrence: string;
  fiscal_year_start_month: number;
  due_rule: string | null;
  due_month_offset: number | null;
  due_day_of_month: number | null;
  due_days_after: number | null;
  unresolved_reason: string | null;
  lead_time_days: number;
  rule_pack: string;
  supersedes_id: string | null;
  status: string;
  is_active: boolean;
}

interface ExceptionRow {
  period_end_month: number;
  due_rule: string;
  due_month_offset: number | null;
  due_day_of_month: number | null;
  due_days_after: number | null;
  note: string;
}

interface StateRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  is_initial: boolean;
  is_terminal: boolean;
  needs_decision: boolean;
  is_filed: boolean;
  sort_order: number;
  is_active: boolean;
}

const TEMPLATE_COLUMNS =
  "id, tenant_id, jurisdiction, entity_type, service_entry_id, module, name, authority, " +
  "recurrence, fiscal_year_start_month, due_rule, due_month_offset, due_day_of_month, " +
  "due_days_after, unresolved_reason, lead_time_days, rule_pack, supersedes_id, status, is_active";

const EXCEPTION_COLUMNS =
  "period_end_month, due_rule, due_month_offset, due_day_of_month, due_days_after, note";

const STATE_COLUMNS =
  "id, tenant_id, code, name, is_initial, is_terminal, needs_decision, is_filed, sort_order, " +
  "is_active";

function toDueRule(r: TemplateRow): DueRule | null {
  if (r.due_rule === null) return null;
  return {
    kind: r.due_rule as DueRule["kind"],
    dueMonthOffset: r.due_month_offset,
    dueDayOfMonth: r.due_day_of_month,
    dueDaysAfter: r.due_days_after,
  };
}

function toTemplate(r: TemplateRow): ObligationTemplate {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    jurisdiction: r.jurisdiction,
    entityType: r.entity_type,
    serviceEntryId: r.service_entry_id,
    module: r.module,
    name: r.name,
    authority: r.authority,
    recurrence: r.recurrence as ObligationTemplate["recurrence"],
    fiscalYearStartMonth: r.fiscal_year_start_month,
    dueRule: toDueRule(r),
    unresolvedReason: r.unresolved_reason,
    leadTimeDays: r.lead_time_days,
    rulePack: r.rule_pack,
    supersedesId: r.supersedes_id,
    status: r.status as ObligationTemplate["status"],
    isActive: r.is_active,
  };
}

function toException(r: ExceptionRow): DueRuleException {
  return {
    periodEndMonth: r.period_end_month,
    kind: r.due_rule as DueRule["kind"],
    dueMonthOffset: r.due_month_offset,
    dueDayOfMonth: r.due_day_of_month,
    dueDaysAfter: r.due_days_after,
    note: r.note,
  };
}

function toState(r: StateRow): ObligationState {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    isInitial: r.is_initial,
    isTerminal: r.is_terminal,
    needsDecision: r.needs_decision,
    isFiled: r.is_filed,
    sortOrder: r.sort_order,
    isActive: r.is_active,
  };
}

export class PostgresObligationTemplateRepository implements ObligationTemplateRepository {
  constructor(private readonly app: Db) {}

  async create(template: NewObligationTemplate): Promise<ObligationTemplate> {
    const created = await this.createIfAbsent(template);
    if (!created) throw new Error("obligation_template insert conflicted");
    return created;
  }

  async createIfAbsent(t: NewObligationTemplate): Promise<ObligationTemplate | null> {
    return withTenant(this.app, t.tenantId, async (db) => {
      const rows = await db<TemplateRow[]>`
        INSERT INTO delivery.obligation_template
          (id, tenant_id, jurisdiction, entity_type, service_entry_id, module, name, authority,
           recurrence, fiscal_year_start_month, due_rule, due_month_offset, due_day_of_month,
           due_days_after, unresolved_reason, lead_time_days, rule_pack, supersedes_id)
        VALUES
          (${t.id}, ${t.tenantId}, ${t.jurisdiction}, ${t.entityType}, ${t.serviceEntryId},
           ${t.module}, ${t.name}, ${t.authority}, ${t.recurrence}, ${t.fiscalYearStartMonth},
           ${t.dueRule?.kind ?? null}, ${t.dueRule?.dueMonthOffset ?? null},
           ${t.dueRule?.dueDayOfMonth ?? null}, ${t.dueRule?.dueDaysAfter ?? null},
           ${t.unresolvedReason}, ${t.leadTimeDays}, ${t.rulePack}, ${t.supersedesId})
        -- The rule's own identity. A revision is a NEW row under a new pack, so
        -- a conflict here means "we already have this exact rule" and the seed
        -- must leave the firm's own confirmations and lead times alone.
        ON CONFLICT (tenant_id, jurisdiction, name, rule_pack) DO NOTHING
        RETURNING ${db.unsafe(TEMPLATE_COLUMNS)}
      `;
      const row = rows[0];
      return row ? toTemplate(row) : null;
    });
  }

  async findById(tenantId: string, templateId: string): Promise<ObligationTemplate | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<TemplateRow[]>`
        SELECT ${db.unsafe(TEMPLATE_COLUMNS)} FROM delivery.obligation_template
        WHERE id = ${templateId}
      `;
      return row ? toTemplate(row) : null;
    });
  }

  async update(
    tenantId: string,
    templateId: string,
    patch: TemplatePatch,
  ): Promise<ObligationTemplate> {
    return withTenant(this.app, tenantId, async (db) => {
      // The service has already resolved every absent field to its current
      // value, so every column is present here and the SQL needs no dynamic
      // assembly — `updateState`'s arrangement in T3.1. COALESCE would have
      // been wrong anyway: clearing a due formula to null is a real edit.
      const [row] = await db<TemplateRow[]>`
        UPDATE delivery.obligation_template SET
          entity_type             = ${patch.entityType},
          service_entry_id        = ${patch.serviceEntryId},
          module                  = ${patch.module},
          authority               = ${patch.authority},
          recurrence              = ${patch.recurrence},
          fiscal_year_start_month = ${patch.fiscalYearStartMonth},
          due_rule                = ${patch.dueRule?.kind ?? null},
          due_month_offset        = ${patch.dueRule?.dueMonthOffset ?? null},
          due_day_of_month        = ${patch.dueRule?.dueDayOfMonth ?? null},
          due_days_after          = ${patch.dueRule?.dueDaysAfter ?? null},
          unresolved_reason       = ${patch.unresolvedReason},
          lead_time_days          = ${patch.leadTimeDays},
          status                  = ${patch.status},
          is_active               = ${patch.isActive}
        WHERE id = ${templateId}
        RETURNING ${db.unsafe(TEMPLATE_COLUMNS)}
      `;
      if (!row) throw new Error(`obligation_template ${templateId} vanished during update`);
      return toTemplate(row);
    });
  }

  async list(tenantId: string): Promise<readonly TemplateRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Retired rules included, deliberately: a retired rule still explains an
      // old filing's date, and the screen marks it rather than hiding it.
      //
      // The service NAME and the instance COUNT are joined here rather than
      // fetched per row — this codebase's own rule, learnt five times: a list
      // that returns ids is one a screen has to re-fetch.
      const rows = await db<(TemplateRow & { service_name: string | null; instance_count: string })[]>`
        SELECT ${db.unsafe(TEMPLATE_COLUMNS.split(", ").map((c) => `t.${c}`).join(", "))},
               v.body->>'name'                          AS service_name,
               COALESCE(i.n, 0)::text                   AS instance_count
        FROM delivery.obligation_template t
        LEFT JOIN config.version v
          ON v.entry_id = t.service_entry_id AND v.tenant_id = t.tenant_id
         AND v.status = 'published'
        LEFT JOIN LATERAL (
          SELECT count(*) AS n FROM delivery.obligation_instance oi
          WHERE oi.template_id = t.id AND oi.tenant_id = t.tenant_id
        ) i ON true
        ORDER BY t.module NULLS LAST, t.name
      `;
      const byTemplate = await this.exceptionsByTemplate(db, rows.map((r) => r.id));
      return rows.map((r) => ({
        template: toTemplate(r),
        exceptions: byTemplate.get(r.id) ?? [],
        serviceName: r.service_name,
        instanceCount: Number(r.instance_count),
      }));
    });
  }

  async listGenerating(
    tenantId: string,
  ): Promise<
    readonly { readonly template: ObligationTemplate; readonly exceptions: readonly DueRuleException[] }[]
  > {
    return withTenant(this.app, tenantId, async (db) => {
      // Active rules that carry a formula. `recurrence <> 'event'` is left to
      // the domain's `generatesDates` rather than duplicated here — one
      // statement of what "generating" means, and the screen reads the same one.
      const rows = await db<TemplateRow[]>`
        SELECT ${db.unsafe(TEMPLATE_COLUMNS)} FROM delivery.obligation_template
        WHERE is_active AND due_rule IS NOT NULL
        ORDER BY jurisdiction, name
      `;
      // EVERY exception for every rule in ONE query rather than one per rule:
      // there are a handful of these in total, and the caller's loop already
      // runs once per rule per period per entity.
      const byTemplate = await this.exceptionsByTemplate(db, rows.map((r) => r.id));
      return rows.map((r) => ({
        template: toTemplate(r),
        exceptions: byTemplate.get(r.id) ?? [],
      }));
    });
  }

  async countAll(tenantId: string): Promise<number> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ n: string }[]>`
        SELECT count(*)::text AS n FROM delivery.obligation_template
      `;
      return Number(row?.n ?? 0);
    });
  }

  private async exceptionsByTemplate(
    db: Db,
    templateIds: readonly string[],
  ): Promise<Map<string, DueRuleException[]>> {
    const out = new Map<string, DueRuleException[]>();
    if (templateIds.length === 0) return out;
    const rows = await db<(ExceptionRow & { template_id: string })[]>`
      SELECT template_id, ${db.unsafe(EXCEPTION_COLUMNS)}
      FROM delivery.obligation_template_exception
      WHERE template_id = ANY(${db.array(templateIds as string[])}::uuid[]) AND is_active
      ORDER BY period_end_month
    `;
    for (const r of rows) {
      const list = out.get(r.template_id) ?? [];
      list.push(toException(r));
      out.set(r.template_id, list);
    }
    return out;
  }
}

export class PostgresObligationExceptionRepository implements ObligationExceptionRepository {
  constructor(private readonly app: Db) {}

  async create(exception: NewException): Promise<DueRuleException> {
    const created = await this.createIfAbsent(exception);
    if (!created) throw new Error("obligation_template_exception insert conflicted");
    return created;
  }

  async createIfAbsent(e: NewException): Promise<DueRuleException | null> {
    return withTenant(this.app, e.tenantId, async (db) => {
      const rows = await db<ExceptionRow[]>`
        INSERT INTO delivery.obligation_template_exception
          (id, tenant_id, template_id, period_end_month, due_rule, due_month_offset,
           due_day_of_month, due_days_after, note)
        VALUES
          (${e.id}, ${e.tenantId}, ${e.templateId}, ${e.periodEndMonth}, ${e.dueRule.kind},
           ${e.dueRule.dueMonthOffset}, ${e.dueRule.dueDayOfMonth}, ${e.dueRule.dueDaysAfter},
           ${e.dueRule.note})
        -- The partial unique index (WHERE is_active) is the arbiter: a WITHDRAWN
        -- March exception must not block its replacement, which is exactly why
        -- uniqueness is partial rather than a table constraint.
        ON CONFLICT (tenant_id, template_id, period_end_month) WHERE is_active DO NOTHING
        RETURNING ${db.unsafe(EXCEPTION_COLUMNS)}
      `;
      const row = rows[0];
      return row ? toException(row) : null;
    });
  }

  async listFor(tenantId: string, templateId: string): Promise<readonly DueRuleException[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<ExceptionRow[]>`
        SELECT ${db.unsafe(EXCEPTION_COLUMNS)} FROM delivery.obligation_template_exception
        WHERE template_id = ${templateId} AND is_active
        ORDER BY period_end_month
      `;
      return rows.map(toException);
    });
  }

  async withdraw(tenantId: string, templateId: string, periodEndMonth: number): Promise<void> {
    // `is_active = false`, never a DELETE. `bib_app` holds no DELETE grant on a
    // single table in this database and this one is not the first: an exception
    // is WHY a filing was due on the day it was, and withdrawing it in June
    // must not erase the reason April's return was dated as it was.
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE delivery.obligation_template_exception SET is_active = false
        WHERE template_id = ${templateId} AND period_end_month = ${periodEndMonth} AND is_active
      `;
    });
  }
}

export class PostgresObligationStateRepository implements ObligationStateRepository {
  constructor(private readonly app: Db) {}

  async list(tenantId: string): Promise<readonly ObligationState[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<StateRow[]>`
        SELECT ${db.unsafe(STATE_COLUMNS)} FROM delivery.obligation_state
        ORDER BY sort_order
      `;
      return rows.map(toState);
    });
  }

  async createMany(states: readonly NewObligationState[]): Promise<readonly ObligationState[]> {
    if (states.length === 0) return [];
    const tenantId = states[0]?.tenantId;
    if (!tenantId) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const out: ObligationState[] = [];
      for (const s of states) {
        const rows = await db<StateRow[]>`
          INSERT INTO delivery.obligation_state
            (id, tenant_id, code, name, is_initial, is_terminal, needs_decision, is_filed,
             sort_order)
          VALUES
            (${s.id}, ${s.tenantId}, ${s.code}, ${s.name}, ${s.isInitial}, ${s.isTerminal},
             ${s.needsDecision}, ${s.isFiled}, ${s.sortOrder})
          ON CONFLICT (tenant_id, code) DO NOTHING
          RETURNING ${db.unsafe(STATE_COLUMNS)}
        `;
        const row = rows[0];
        if (row) out.push(toState(row));
      }
      return out;
    });
  }
}
