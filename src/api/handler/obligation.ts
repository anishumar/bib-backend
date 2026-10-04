// The compliance calendar over HTTP (T3.2) — transport only. Each handler
// parses the validated input, calls exactly one use-case method, and maps the
// result field by field. Never forwards a domain object: zod-openapi documents a
// response without validating it, so a field on the wire but not in the schema
// is a field the generated frontend client cannot see.
//
// ── THERE IS NO `POST /obligations`, AND THERE WILL NOT BE ─────────────────
//
// The calendar is GENERATED from rules, entities and engagements. A route that
// let a human add a row would let the calendar disagree with the statute, and a
// calendar that can drift is Excel with extra steps. What a person may do is
// change the RULES, which is what the four rule routes are for.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { ObligationService } from "../../usecase/obligation/service";
import type { ObligationVocabularyService } from "../../usecase/obligation/vocabulary";
import {
  coverageOf,
  daysBetween,
  type ObligationState,
  type ResolutionOption,
} from "../../domain/obligation/model";
import type { ChainRowView, RuleView } from "../../usecase/obligation/service";
import type { ObligationTemplate } from "../../domain/obligation/model";
import { scopeOf } from "../scope";

export interface ObligationDeps {
  readonly service: ObligationService;
  readonly vocabulary: ObligationVocabularyService;
}

// ── Shared vocabulary ───────────────────────────────────────────────────────

const Recurrence = z
  .enum(["monthly", "quarterly", "half_yearly", "annual", "event"])
  .openapi({
    description:
      "How often the filing comes round. 'event' means it is triggered by something happening " +
      "— a share allotment, a director change — so it has no period and produces no calendar " +
      "entries, because nothing in this system yet knows the event occurred. It is still a " +
      "row so the firm can see that the obligation is known about.",
  });

const DueRuleKind = z.enum(["day_of_month", "days_after"]).openapi({
  description:
    "'day_of_month' is N months after the period ends, then day D — 'the 20th of the month " +
    "following'. 'days_after' is N days after the period ends. Both are DATA rather than a " +
    "formula somebody has to parse, which is what lets the database check them.",
});

const RuleStatus = z.enum(["unconfirmed", "confirmed"]).openapi({
  description:
    "Whether a partner has checked this date against the statute. Everything ships " +
    "'unconfirmed', India included: the dates came from a document rather than from the firm, " +
    "and the firm's own practice may be earlier than the law.",
});

const Coverage = z
  .enum(["generating", "needs_formula", "event_driven", "unlinked", "unconfirmed", "retired"])
  .openapi({
    description:
      "What this rule is actually doing, derived rather than stored. 'needs_formula' is NOT an " +
      "error and is the ordinary state of most of the shipped pack: the obligation is real and " +
      "its timing depends on a fact this system does not hold (an AGM date, a State, a " +
      "turnover), and the reason is on the rule. 'unlinked' means no service in the catalogue " +
      "carries it, so it adds nothing to the calendar; adding it to a service there puts it " +
      "on the calendar for that service's clients, and confirms it if it was unconfirmed.",
  });

const UsedInSchema = z
  .object({
    serviceEntryId: z.string().uuid().openapi({
      description: "The catalogue service's entry id: what the link and unlink routes take.",
    }),
    serviceKey: z.string().openapi({
      description:
        "The service's catalogue key. The catalogue screen anchors each service on it, so a " +
        "library row can link straight to the service that uses it.",
    }),
    serviceName: z.string().nullable().openapi({
      description:
        "The published version's name, else the newest version's. Null only for a service with " +
        "no version at all; show the key then.",
    }),
    linkedAt: z.string().openapi({
      description:
        "When the filing was added to this service, as an ISO instant. Links moved in by " +
        "migration 0309 carry the moment it ran.",
    }),
  })
  .openapi("ObligationRuleUsedIn");

const DueRuleSchema = z
  .object({
    kind: DueRuleKind,
    dueMonthOffset: z.number().int().min(0).nullable(),
    dueDayOfMonth: z.number().int().min(1).max(31).nullable(),
    dueDaysAfter: z.number().int().min(0).nullable(),
  })
  .openapi("ObligationDueRule");

const ExceptionSchema = z
  .object({
    periodEndMonth: z.number().int().min(1).max(12).openapi({
      description:
        "The calendar month the filed PERIOD ends in. March is 3 — the month of the deduction, " +
        "never the month it is due, because the due month is exactly what the exception changes.",
    }),
    kind: DueRuleKind,
    dueMonthOffset: z.number().int().nullable(),
    dueDayOfMonth: z.number().int().nullable(),
    dueDaysAfter: z.number().int().nullable(),
    note: z.string().openapi({
      description:
        "Why this period is different, in the firm's own words. Mandatory: a partner checking " +
        "the calendar against the statute cannot otherwise tell a real carve-out from a typo.",
    }),
  })
  .openapi("ObligationException");

// ── A chain read on the firm's today (T6.16 follow-up) ───────────────────────
//
// After "the law changed from April 2027", the chain's open-ended row is the
// successor, and a card showing its formula told a partner September was due
// on the new day while the calendar dated it on the old one. So every rule row
// also carries the row whose window governs the period containing the FIRM's
// today, and the row that takes over next, in one shape.

const ChainRowFields = {
  ruleId: z.string().uuid().openapi({
    description:
      "The rule row this is. Any rule id of the chain is accepted by the link, unlink and " +
      "library routes.",
  }),
  effectiveTo: z.string().nullable().openapi({
    description:
      "The day this row stops, as recorded, or null when nothing replaces it. A period that " +
      "STARTS on or after it is not this row's; one that started before it still is, so a " +
      "quarter already running when the law changes stays with this row.",
  }),
  dueRule: DueRuleSchema.nullable().openapi({
    description:
      "When a filing under this row is due, in the same shape as the rule's own dueRule. Null " +
      "while the date cannot be worked out yet; unresolvedReason then says why.",
  }),
  unresolvedReason: z.string().nullable().openapi({
    description:
      "Present exactly when this row has no due formula: what it is still waiting for, in the " +
      "firm's own words, shown in place of a date.",
  }),
  exceptions: z.array(ExceptionSchema).openapi({
    description: "This row's own exceptions, such as March's TDS. A successor does not inherit them.",
  }),
  coverage: Coverage.openapi({
    description:
      "What THIS row is doing, judged as the rule's own coverage is, with the chain's services: " +
      "'generating' when the calendar dates the periods it governs, 'retired' when it dates " +
      "none of them, and so on. After a law change it can differ from the rule's own coverage, " +
      "which is the newest row's, so a screen saying what today's filings are doing reads this.",
  }),
};

const InForceTodaySchema = z
  .object({
    ...ChainRowFields,
    effectiveFrom: z.string().nullable().openapi({
      description:
        "The day this row starts, as recorded; null means from the beginning. It governs the " +
        "periods that START on or after it.",
    }),
  })
  .openapi("ObligationRuleInForceToday");

const NextChangeSchema = z
  .object({
    ...ChainRowFields,
    effectiveFrom: z.string().openapi({
      description:
        "The day the change was recorded to take effect from, as YYYY-MM-DD. It can fall inside " +
        "a period the old row still governs; firstPeriodStart is when the new row takes over.",
    }),
    firstPeriodStart: z.string().openapi({
      description:
        "The start of the first period the new row governs, as YYYY-MM-DD, found the way the " +
        "calendar dates periods: the day to name in 'From April 2027: the 22nd of the " +
        "following month'. For a quarterly rule changed on 1 August it is 1 October, because " +
        "the July to September quarter is still the old rule's.",
    }),
  })
  .openapi("ObligationRuleNextChange");

const RuleSchema = z
  .object({
    id: z.string().uuid(),
    jurisdiction: z.string(),
    lineageId: z.string().uuid().openapi({
      description:
        "The rule's chain: the first rule's id, shared by every rule that later replaced it when " +
        "the law changed. A catalogue service carries the CHAIN, so every row of one chain " +
        "shows the same usedIn, and the catalogue's filings list has one row per chain.",
    }),
    entityType: z.string().nullable().openapi({
      description: "Null means every entity type — the common case: GST does not care what " +
        "shape the company is.",
    }),
    usedIn: z.array(UsedInSchema).openapi({
      description:
        "The catalogue services that carry this filing, named. Empty means no service does, so " +
        "the rule adds nothing to the calendar. Services are added and removed in the " +
        "Catalogue, the one place a filing is linked to a service.",
    }),
    module: z.string().nullable().openapi({
      description:
        "The STATUTE's grouping — 'GST', 'TDS', 'MCA'. Not the firm's revenue Dept, which is a " +
        "different axis: a client can buy FRC work that produces GST obligations.",
    }),
    name: z.string(),
    authority: z.string().nullable(),
    recurrence: Recurrence,
    fiscalYearStartMonth: z.number().int().min(1).max(12).openapi({
      description: "4 for India. An Indian quarter runs Apr-Jun, so leaving this at 1 would " +
        "put every quarterly filing in the wrong period.",
    }),
    dueRule: DueRuleSchema.nullable(),
    unresolvedReason: z.string().nullable().openapi({
      description:
        "Present exactly when there is no due formula: what this system still needs before it " +
        "can produce a date. This is what the screen shows in place of a deadline.",
    }),
    leadTimeDays: z.number().int().min(0).openapi({
      description:
        "T-X, the firm's own practice rather than the law: how many days before the statutory " +
        "date the task appears. Ships at 0 for every rule, because nobody has told us the " +
        "firm's lead times and a guessed one is a commitment it never made.",
    }),
    rulePack: z.string(),
    supersedesId: z.string().uuid().nullable(),
    status: RuleStatus,
    isActive: z.boolean(),
    effectiveFrom: z.string().nullable().openapi({
      description:
        "The first period START this rule governs — null means from the beginning. Tested " +
        "against the period rather than the due date: August's return is August's law even " +
        "though it falls due on 20 September.",
    }),
    effectiveTo: z.string().nullable().openapi({
      description:
        "The first period start this rule does NOT govern — the day its successor takes over. " +
        "Half-open, so a rule ending on the 1st and its successor starting on the 1st govern " +
        "one period each and never the same one. Null means forever, which is every rule " +
        "nobody has had to amend.",
    }),
    coverage: Coverage,
    exceptions: z.array(ExceptionSchema),
    inForceToday: InForceTodaySchema.nullable().openapi({
      description:
        "The row of this rule's CHAIN whose window governs the period containing the firm's " +
        "today (the firm's own time zone): the rule today's filings are due under, which is " +
        "what a screen shows as the due date. The same on every row of one chain. Differs from " +
        "this row after a law change that takes effect later, when this row is the successor. " +
        "Null when no row governs today yet, for a chain written to start later.",
    }),
    nextChange: NextChangeSchema.nullable().openapi({
      description:
        "The row that takes over after today's period, when a law change has been recorded for " +
        "a later day. Null when nothing changes.",
    }),
    instanceCount: z.number().int().openapi({
      description:
        "How many calendar rows this rule has produced, ever, including any taken off the " +
        "calendar when a service stopped including them. It is what decides whether the " +
        "period shape can still change.",
    }),
  })
  .openapi("ObligationRule");

const LinkEffectSchema = z
  .object({
    linked: z.boolean().openapi({
      description:
        "False when the filing was already on this service: nothing was written and nothing " +
        "recorded, so pressing Add twice is harmless.",
    }),
    confirmed: z.boolean().openapi({
      description:
        "Adding it also CONFIRMED a rule nobody at the firm had checked. The screen showed its " +
        "dates in words before the person pressed Add, which is what confirming is.",
    }),
    spawned: z.number().int().openapi({
      description: "Filings this put on the calendar for the service's live clients, now.",
    }),
    restored: z.number().int().openapi({
      description:
        "Filings taken off the calendar when this filing was earlier removed from a service, " +
        "and brought back by adding it again.",
    }),
    companies: z.number().int().openapi({
      description: "How many companies those filings are for.",
    }),
  })
  .openapi("ObligationLinkEffect");

const UnlinkEffectSchema = z
  .object({
    unlinked: z.boolean().openapi({
      description: "False when the filing was not on this service: nothing changed.",
    }),
    withdrawn: z.number().int().openapi({
      description:
        "Upcoming filings nobody had started, taken off the calendar for the clients no other " +
        "service still covers. Kept and marked, never deleted.",
    }),
    kept: z.number().int().openapi({
      description:
        "Filings of this service that stayed on the calendar: the three counts below added up.",
    }),
    keptStarted: z.number().int().openapi({
      description: "Kept because work on them has started: a task, a filing, or a decision.",
    }),
    keptPastDue: z.number().int().openapi({
      description:
        "Kept because their date has passed or a partner's decision is waiting on them. " +
        "Removing them would hide a deadline the client may have missed.",
    }),
    keptCoveredElsewhere: z.number().int().openapi({
      description:
        "Kept because another service the same client holds still includes this filing.",
    }),
  })
  .openapi("ObligationUnlinkEffect");

const RuleEffectSchema = z
  .object({
    restated: z.number().int().openapi({
      description:
        "Filings already on the calendar whose dates this edit MOVED. The sweep materialises a " +
        "year ahead and generation is idempotent, so an edit that did not restate would be " +
        "invisible until next year — this number is how the screen proves it was not.",
    }),
    locked: z.number().int().openapi({
      description:
        "Filings this edit could NOT touch, because somebody has already picked them up or " +
        "filed them. A task on a desk keeps the date its owner is working to. Shown rather " +
        "than hidden: a partial change reported as a whole one is how a deadline moves without " +
        "anybody being told.",
    }),
    spawned: z.number().int().openapi({
      description:
        "Filings this rule newly put on the calendar. Non-zero when a rule that was waiting on " +
        "a fact has just been given its formula — which is the whole point of the screen.",
    }),
  })
  .openapi("ObligationRuleEffect");

const CalendarRowSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    authority: z.string().nullable(),
    module: z.string().nullable(),
    entityPartyId: z.string().uuid(),
    entityName: z.string().nullable(),
    clientName: z.string().nullable(),
    periodLabel: z.string().openapi({
      description: "'Aug 2026', 'Q2 FY2026-27'. Stored rather than derived, so a rule retired " +
        "later cannot change how a filing already made is described.",
    }),
    statutoryDueOn: z.string().openapi({
      description: "What the LAW says. Missing it is the client's money.",
    }),
    internalTargetOn: z.string().openapi({
      description:
        "What the FIRM gave itself, T-X earlier. This is the actionable date and the one the " +
        "list is ordered by — a list sorted by the legal deadline tells you when you are " +
        "already too late.",
    }),
    stateCode: z.string(),
    stateName: z.string(),
    isTerminal: z.boolean(),
    needsDecision: z.boolean(),
    workItemId: z.string().uuid().nullable().openapi({
      description: "The task raised for it, once T-X has arrived. Null is 'known, not yet " +
        "started' — a year of those is the calendar's normal state, not a backlog.",
    }),
    filedOn: z.string().nullable(),
    filedByWorkItemId: z.string().uuid().nullable().openapi({
      description:
        "The task that filed it (Q063): its own task, or the period job's task that covered " +
        "it. Null while unfiled.",
    }),
    filedByTitle: z.string().nullable().openapi({ description: "That task's title, e.g. 'GST · Sep 2026'." }),
    resolutionOptionId: z.string().uuid().nullable(),
    resolutionName: z.string().nullable().openapi({
      description:
        "What the partner chose, in the firm's own words. Joined rather than left as an id: a " +
        "list that returns uuids is one somebody has to fetch per row.",
    }),
    resolutionReason: z.string().nullable().openapi({
      description:
        "WHY they chose it. The half nobody remembers eighteen months later, and the reason " +
        "this feature exists — it is deliberately NOT in the audit log, because it is a " +
        "partner's free text about a client and may name a person.",
    }),
    resolvedAt: z.string().nullable(),
    ruleUnconfirmed: z.boolean().openapi({
      description:
        "The rule behind this date has not been confirmed by the firm. Shown rather than " +
        "hidden: a plausible-looking wrong due date is the dangerous kind.",
    }),
    rulePack: z.string(),
  })
  .openapi("CalendarRow");

const CoverageGapSchema = z
  .object({
    engagementId: z.string().uuid(),
    entityPartyId: z.string().uuid(),
    entityName: z.string().nullable(),
    clientName: z.string().nullable(),
    serviceName: z.string().nullable(),
    jurisdiction: z.string().nullable(),
    reason: z
      .enum([
        "entity_not_registered",
        "no_rule_names_this_service",
        "no_rule_for_jurisdiction",
        "rules_need_a_formula",
        "rules_retired",
        "rules_unconfirmed",
        "nothing_due_yet",
      ])
      .openapi({
        description:
          "Why the calendar produced nothing for this engagement. NONE of these is an error: " +
          "'no_rule_names_this_service' means no compliance filing is linked to this service in " +
          "the catalogue, which is the ordinary state of advisory work. Each names something a " +
          "partner can do next, which is the point: an empty calendar with no explanation is " +
          "indistinguishable from broken software.",
      }),
    blockedRuleIds: z.array(z.string().uuid()).openapi({
      description: "Rules linked to this service that could not be used, so the screen can link " +
        "straight to them.",
    }),
  })
  .openapi("CoverageGap");

function exceptionsToWire(v: ChainRowView["exceptions"]): z.infer<typeof ExceptionSchema>[] {
  return v.map((e) => ({
    periodEndMonth: e.periodEndMonth,
    kind: e.kind,
    dueMonthOffset: e.dueMonthOffset,
    dueDayOfMonth: e.dueDayOfMonth,
    dueDaysAfter: e.dueDaysAfter,
    note: e.note,
  }));
}

function dueRuleToWire(t: ObligationTemplate): z.infer<typeof DueRuleSchema> | null {
  return t.dueRule
    ? {
        kind: t.dueRule.kind,
        dueMonthOffset: t.dueRule.dueMonthOffset,
        dueDayOfMonth: t.dueRule.dueDayOfMonth,
        dueDaysAfter: t.dueRule.dueDaysAfter,
      }
    : null;
}

/** One row of a chain. `linkedServices` is the CHAIN's link count, the same
 *  `coverageOf` argument the rule's own coverage is judged with, so a row's
 *  coverage and the rule's can differ only by the row. */
function chainRowToWire(v: ChainRowView, linkedServices: number) {
  return {
    ruleId: v.template.id,
    effectiveTo: v.template.effectiveTo,
    dueRule: dueRuleToWire(v.template),
    unresolvedReason: v.template.unresolvedReason,
    exceptions: exceptionsToWire(v.exceptions),
    coverage: coverageOf(v.template, linkedServices),
  };
}

/** A just-written rule the list could not find, which nothing that deletes a
 *  rule can cause (nothing does). Its chain is not read, so the day's reading
 *  is null rather than invented. */
function unread(rule: ObligationTemplate): RuleView {
  return {
    template: rule,
    exceptions: [],
    usedIn: [],
    instanceCount: 0,
    inForceToday: null,
    nextChange: null,
  };
}

function ruleToWire(r: RuleView): z.infer<typeof RuleSchema> {
  const t = r.template;
  const today = r.inForceToday;
  const next = r.nextChange;
  return {
    id: t.id,
    lineageId: t.lineageId,
    jurisdiction: t.jurisdiction,
    entityType: t.entityType,
    // Field by field, like everything else here: a spread would put whatever
    // the read model grows next on the wire without the schema saying so.
    usedIn: r.usedIn.map((u) => ({
      serviceEntryId: u.serviceEntryId,
      serviceKey: u.serviceKey,
      serviceName: u.serviceName,
      linkedAt: u.linkedAt,
    })),
    module: t.module,
    name: t.name,
    authority: t.authority,
    recurrence: t.recurrence,
    fiscalYearStartMonth: t.fiscalYearStartMonth,
    dueRule: dueRuleToWire(t),
    unresolvedReason: t.unresolvedReason,
    leadTimeDays: t.leadTimeDays,
    rulePack: t.rulePack,
    supersedesId: t.supersedesId,
    status: t.status,
    isActive: t.isActive,
    effectiveFrom: t.effectiveFrom,
    effectiveTo: t.effectiveTo,
    // DERIVED here rather than stored, so the screen and the generator cannot
    // disagree about what a rule is doing. The link count is the chain's, from
    // the same query.
    coverage: coverageOf(t, r.usedIn.length),
    exceptions: exceptionsToWire(r.exceptions),
    inForceToday:
      today === null
        ? null
        : {
            ...chainRowToWire(today, r.usedIn.length),
            effectiveFrom: today.template.effectiveFrom,
          },
    // A next row always opens on a day (`chainOnDay` picks it by its start),
    // so a null start here is not a change anybody recorded.
    nextChange:
      next === null || next.template.effectiveFrom === null
        ? null
        : {
            ...chainRowToWire(next, r.usedIn.length),
            effectiveFrom: next.template.effectiveFrom,
            firstPeriodStart: next.firstPeriodStart,
          },
    instanceCount: r.instanceCount,
  };
}

// ── Request schemas ─────────────────────────────────────────────────────────

const CreateRuleRequest = z
  .object({
    jurisdiction: z.string().length(2),
    entityType: z.string().nullable().optional(),
    serviceEntryIds: z.array(z.string().uuid()).max(50).optional().openapi({
      description:
        "The catalogue services this new filing is added to, in the same act: the catalogue's " +
        "'Write a new filing' sends the service it was written on, and that service's live " +
        "clients get the filings on the calendar straight away. Absent or empty is the library " +
        "writing a rule on no service, which adds nothing to the calendar until a service " +
        "carries it.",
    }),
    module: z.string().nullable().optional(),
    name: z.string().min(1),
    authority: z.string().nullable().optional(),
    recurrence: Recurrence,
    fiscalYearStartMonth: z.number().int().min(1).max(12).default(4),
    dueRule: DueRuleSchema.nullable(),
    unresolvedReason: z.string().nullable().optional(),
    leadTimeDays: z.number().int().min(0).default(0),
    rulePack: z.string().min(1),
    supersedesId: z.string().uuid().nullable().optional(),
  })
  .openapi("CreateObligationRuleRequest");

const UpdateRuleRequest = z
  .object({
    entityType: z.string().nullable().optional(),
    module: z.string().nullable().optional(),
    authority: z.string().nullable().optional(),
    recurrence: Recurrence.optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    dueRule: DueRuleSchema.nullable().optional(),
    unresolvedReason: z.string().nullable().optional(),
    leadTimeDays: z.number().int().min(0).optional(),
    status: RuleStatus.optional(),
    isActive: z.boolean().optional(),
  })
  .openapi("UpdateObligationRuleRequest");

const SupersedeRuleRequest = z
  .object({
    effectiveFrom: z.string().openapi({
      description:
        "The day the new rule takes over, as a PERIOD start. Half-open: the predecessor governs " +
        "every period beginning before this day and the successor every period from it, so " +
        "exactly one rule governs each return.",
    }),
    rulePack: z.string().min(1).openapi({
      description:
        "The successor's OWN pack, and it may not be the predecessor's — a pack is part of a " +
        "rule's identity, which is what lets a filing made last year still name the version it " +
        "was due under.",
    }),
    dueRule: DueRuleSchema.nullable(),
    unresolvedReason: z.string().nullable().optional(),
    leadTimeDays: z.number().int().min(0).optional(),
    authority: z.string().nullable().optional(),
    module: z.string().nullable().optional(),
    entityType: z.string().nullable().optional(),
  })
  .openapi("SupersedeObligationRuleRequest");

const ServiceParam = z.object({
  serviceEntryId: z.string().uuid().openapi({
    description: "The catalogue service's entry id (the entry, not a version).",
  }),
});

const ServiceRuleParam = z.object({
  serviceEntryId: z.string().uuid().openapi({
    description: "The catalogue service's entry id (the entry, not a version).",
  }),
  ruleId: z.string().uuid().openapi({
    description:
      "Any rule of the filing's chain: its lineageId or the rule in force. The chain is what " +
      "is removed, so every rule that replaced another comes off together.",
  }),
});

const LinkFilingRequest = z
  .object({
    ruleId: z.string().uuid().openapi({
      description:
        "Any rule of the filing's chain; the chain is what is added, and its rule in force is " +
        "what is judged. An unconfirmed rule with a formula is confirmed by adding it.",
    }),
  })
  .openapi("LinkObligationFilingRequest");

const AddExceptionRequest = z
  .object({
    periodEndMonth: z.number().int().min(1).max(12),
    kind: DueRuleKind,
    dueMonthOffset: z.number().int().min(0).nullable().optional(),
    dueDayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    dueDaysAfter: z.number().int().min(0).nullable().optional(),
    note: z.string().min(1),
  })
  .openapi("AddObligationExceptionRequest");

const RuleParam = z.object({ ruleId: z.string().uuid() });
const ExceptionParam = z.object({
  ruleId: z.string().uuid(),
  periodEndMonth: z.coerce.number().int().min(1).max(12),
});

const CalendarParams = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  entityPartyId: z.string().uuid().optional(),
  module: z.string().optional(),
  // A STRING ON THE WIRE, and not `z.coerce.boolean()`. That coercion is
  // `Boolean(value)`, and `Boolean("false")` is TRUE — so `includeSettled=false`
  // meant "include them", every caller unticking the box was silently ignored,
  // and the whole filter did nothing whatever the screen showed. Found by
  // running the chain, not by a test: the parameter parsed, the query ran, and
  // the wrong branch is indistinguishable from the right one until a row is
  // actually terminal — which nothing could make it until 0054.
  //
  // The enum also puts the accepted values in the spec, so the generated client
  // makes the frontend say which it means instead of relying on how a boolean
  // happens to be serialised into a query string.
  includeSettled: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ── Routes ──────────────────────────────────────────────────────────────────
//
// READS are `party:read`, the same permission the work board takes: what a
// client owes and when is delivery state, it carries no money, and everybody on
// the team needs to see it.
//
// WRITING A RULE is `tenant:admin`, and that is a deliberate step up from
// `work:write`. A due date is a RULE — a wrong one costs the CLIENT a penalty,
// not the firm an afternoon — and confirming one is a partner taking
// responsibility for it. This is the firm describing what the law asks of its
// clients, which is the same class of act as describing its own Depts.

const listRulesRoute = createRoute({
  method: "get",
  path: "/api/v1/obligation-rules",
  tags: ["obligations"],
  summary: "Every compliance rule at this firm, retired ones included",
  description:
    "Retired rules are returned on purpose: a retired rule still explains why an old filing " +
    "was due when it was. `coverage` says what each rule is actually doing — and a " +
    "'needs_formula' rule is a QUESTION for the firm, not a fault.",
  responses: {
    200: {
      description: "The rules",
      content: {
        "application/json": {
          schema: z.object({
            rules: z.array(RuleSchema),
            /** So the screen can offer to load the shipped pack rather than
             *  showing an empty table with no explanation. */
            ruleCount: z.number().int(),
          }),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

const seedRulesRoute = createRoute({
  method: "post",
  path: "/api/v1/obligation-rules/seed-india",
  tags: ["obligations"],
  summary: "Load the shipped India rule pack",
  description:
    "Fifty-seven rules from the firm's own applicability sheet. Ten produce dates; the rest " +
    "record what they are still waiting on. Idempotent on the rule's identity, so running it " +
    "twice adds nothing and never overwrites a rule a partner has confirmed or given a lead " +
    "time to. New firms get this automatically at creation.",
  responses: {
    200: {
      description: "How many rules were added",
      content: { "application/json": { schema: z.object({ created: z.number().int() }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/api/v1/obligation-rules",
  tags: ["obligations"],
  summary: "Write a compliance rule",
  request: {
    body: { content: { "application/json": { schema: CreateRuleRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Written",
      content: {
        "application/json": { schema: z.object({ rule: RuleSchema, effect: RuleEffectSchema }) },
      },
    },
    400: errorResponse(
      "A half-stated due formula, or a rule with neither a formula nor a reason for not having one",
    ),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("One of the catalogue services it is written for does not exist at this firm"),
    409: errorResponse("This firm already has a rule with that jurisdiction, name and pack"),
  },
});

const updateRuleRoute = createRoute({
  method: "patch",
  path: "/api/v1/obligation-rules/{ruleId}",
  tags: ["obligations"],
  summary: "Edit, confirm or retire a rule",
  description:
    "Jurisdiction, name and rule pack are a rule's IDENTITY and cannot be changed here: every " +
    "obligation already generated pins this row, so moving the identity would silently restate " +
    "why those filings were due when they were. A revision is a new rule under a new pack.",
  request: {
    params: RuleParam,
    body: { content: { "application/json": { schema: UpdateRuleRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": { schema: z.object({ rule: RuleSchema, effect: RuleEffectSchema }) },
      },
    },
    400: errorResponse("A half-stated formula, or a formula and an unresolved reason together"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such rule at this firm"),
  },
});

const supersedeRuleRoute = createRoute({
  method: "post",
  path: "/api/v1/obligation-rules/{ruleId}/supersede",
  tags: ["obligations"],
  summary: "The law changed from a day — hand this rule over to a successor",
  description:
    "NOT an edit and NOT a retirement. Editing a rule in place is a CORRECTION — the shipped " +
    "dates came from a document and everything ships `unconfirmed`, so supplying the real " +
    "formula is recording the law properly for the first time. This is an AMENDMENT: the old " +
    "formula was RIGHT for every period before the cutover, and a filing made under it has to " +
    "go on explaining its own date. So the predecessor is closed at the cutover rather than " +
    "retired — it still governs its own periods — and the successor opens on the same day, in " +
    "ONE transaction, because either half alone is a silently broken calendar: a missing " +
    "successor stops the firm's clients being told about a filing they still owe, and an " +
    "un-closed predecessor puts every later return on the calendar TWICE.",
  request: {
    params: RuleParam,
    body: { content: { "application/json": { schema: SupersedeRuleRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The successor, and what it did to the calendar",
      content: {
        "application/json": { schema: z.object({ rule: RuleSchema, effect: RuleEffectSchema }) },
      },
    },
    400: errorResponse(
      "A cutover that is not a day, one at or before this rule's own start, a half-stated " +
        "formula, or a successor reusing the predecessor's rule pack",
    ),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such rule at this firm"),
    409: errorResponse("This rule already hands over on a day, so it is not the one in force"),
  },
});

const addExceptionRoute = createRoute({
  method: "post",
  path: "/api/v1/obligation-rules/{ruleId}/exceptions",
  tags: ["obligations"],
  summary: "The one period a rule does not apply to itself",
  description:
    "March's TDS deposit is due 30 April while the other eleven months are due on the 7th. A " +
    "template holds ONE formula, and reading only the normal half gives a rule that is right " +
    "eleven months a year and quietly wrong every April.",
  request: {
    params: RuleParam,
    body: { content: { "application/json": { schema: AddExceptionRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Added",
      content: {
        "application/json": {
          schema: z.object({ exception: ExceptionSchema, effect: RuleEffectSchema }),
        },
      },
    },
    400: errorResponse("A half-stated formula, a missing note, or an event-driven rule"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such rule at this firm"),
    409: errorResponse("This rule already has an exception for that period month"),
  },
});

const withdrawExceptionRoute = createRoute({
  method: "delete",
  path: "/api/v1/obligation-rules/{ruleId}/exceptions/{periodEndMonth}",
  tags: ["obligations"],
  summary: "Withdraw an exception, so the rule's own formula governs that period again",
  request: { params: ExceptionParam },
  responses: {
    200: {
      description: "Withdrawn, and what that did to the calendar",
      content: { "application/json": { schema: z.object({ effect: RuleEffectSchema }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such rule, or no exception for that month"),
  },
});

// ── which services owe which filing (T6.16) ────────────────────────────────
//
// The catalogue is the ONE place a filing is linked to a service (decision 3),
// so these routes hang off the service. Reading is `party:read`, like every
// read of the compliance calendar; adding and removing is `tenant:admin`, like
// every other write to it, because it decides which of the firm's clients owe
// a statutory filing.

const listFilingsRoute = createRoute({
  method: "get",
  path: "/api/v1/obligation-filings",
  tags: ["obligations"],
  summary: "Every compliance filing at this firm, once each, and where it is used",
  description:
    "One row per filing: the rule IN FORCE of each chain, retired ones included, each with the " +
    "services that carry it. The catalogue reads this once for the whole page: its picker " +
    "offers the active ones grouped by module, and each service finds its own filings here by " +
    "usedIn, so twenty services cost one request rather than twenty.",
  responses: {
    200: {
      description: "The filings",
      content: { "application/json": { schema: z.object({ filings: z.array(RuleSchema) }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

const serviceFilingsRoute = createRoute({
  method: "get",
  path: "/api/v1/services/{serviceEntryId}/filings",
  tags: ["obligations"],
  summary: "The compliance filings one catalogue service carries",
  request: { params: ServiceParam },
  responses: {
    200: {
      description: "The service's filings, as the rule in force of each",
      content: { "application/json": { schema: z.object({ filings: z.array(RuleSchema) }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
    404: errorResponse("No catalogue service with that id at this firm"),
  },
});

const linkFilingRoute = createRoute({
  method: "post",
  path: "/api/v1/services/{serviceEntryId}/filings",
  tags: ["obligations"],
  summary: "Add a compliance filing to a service",
  description:
    "The service's live clients get the filing on the calendar straight away, one filing per " +
    "period however many of their services carry it. Adding an unconfirmed rule confirms it " +
    "in the same act. Adding a filing that is already on the service changes nothing and " +
    "answers linked: false.",
  request: {
    params: ServiceParam,
    body: { content: { "application/json": { schema: LinkFilingRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The filing as the service now shows it, and what adding it did",
      content: {
        "application/json": { schema: z.object({ rule: RuleSchema, effect: LinkEffectSchema }) },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such rule, or no catalogue service with that id, at this firm"),
  },
});

const unlinkFilingRoute = createRoute({
  method: "post",
  path: "/api/v1/services/{serviceEntryId}/filings/{ruleId}/unlink",
  tags: ["obligations"],
  summary: "Remove a compliance filing from a service",
  description:
    "Nothing is deleted. The link is marked removed, and the service's upcoming filings nobody " +
    "has started are taken off the calendar for the clients no other service still covers. " +
    "Started, filed, decided and past-due filings stay and are counted. Adding the filing back " +
    "brings the removed ones back.",
  request: { params: ServiceRuleParam },
  responses: {
    200: {
      description: "The filing, and what removing it did",
      content: {
        "application/json": { schema: z.object({ rule: RuleSchema, effect: UnlinkEffectSchema }) },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such rule, or no catalogue service with that id, at this firm"),
  },
});

const calendarRoute = createRoute({
  method: "get",
  path: "/api/v1/calendar",
  tags: ["obligations"],
  summary: "What the firm's clients owe, and by when",
  description:
    "Ordered by the INTERNAL target rather than the statutory date, because that is the " +
    "actionable one. Settled rows are excluded unless asked for: within a year they are almost " +
    "the whole table and never the answer.",
  request: { query: CalendarParams },
  responses: {
    200: {
      description: "The calendar",
      content: { "application/json": { schema: z.object({ rows: z.array(CalendarRowSchema) }) } },
    },
    400: errorResponse("A date that is not YYYY-MM-DD"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

const coverageRoute = createRoute({
  method: "get",
  path: "/api/v1/calendar/coverage",
  tags: ["obligations"],
  summary: "Live engagements the calendar has produced nothing for, and why",
  description:
    "THE ANSWER TO AN EMPTY CALENDAR. Every row names a reason, and none of them is an error " +
    "— most advisory work legitimately has no compliance rule. What this screen prevents is a " +
    "firm looking at an empty calendar and having to guess whether the software is broken.",
  responses: {
    200: {
      description: "The gaps",
      content: { "application/json": { schema: z.object({ gaps: z.array(CoverageGapSchema) }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

// ── the decision queue (T3.3) ───────────────────────────────────────────────

const DecisionRowSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    authority: z.string().nullable(),
    module: z.string().nullable(),
    entityPartyId: z.string().uuid(),
    entityName: z.string().nullable(),
    clientName: z.string().nullable(),
    periodLabel: z.string(),
    statutoryDueOn: z.string().openapi({
      description:
        "The date that passed. This list is ordered by it, OLDEST FIRST — the row that has " +
        "been late longest is the one costing the most.",
    }),
    internalTargetOn: z.string(),
    daysLate: z.number().int().openapi({
      description:
        "How many days past the statutory date, as of the caller's own day. Computed on the " +
        "server from the date the CALLER sent, so a partner in Delhi opening this at 04:11 " +
        "does not read yesterday's number.",
    }),
    stateId: z.string().uuid(),
    stateCode: z.string(),
    stateName: z.string(),
    workItemId: z.string().uuid().nullable().openapi({
      description:
        "The task raised for it, if one was. A partner choosing 'file it late' wants to see " +
        "whether somebody is already on it.",
    }),
    ruleUnconfirmed: z.boolean(),
  })
  .openapi("DecisionRow");

const DecisionQueryParams = z.object({
  asOf: z.string().optional().openapi({
    description:
      "The caller's own calendar day, YYYY-MM-DD. Only `daysLate` depends on it — which rows " +
      "are in the queue is decided by the nightly sweep, not by this read. Omitted falls back " +
      "to the server's day, which is a day out for anyone east of Greenwich each morning.",
  }),
});

const decisionQueueRoute = createRoute({
  method: "get",
  path: "/api/v1/calendar/decisions",
  tags: ["obligations"],
  summary: "Deadlines that have passed, waiting on a partner",
  description:
    "A WORKLIST, not a window — deliberately unlike /calendar. An obligation missed in April " +
    "is still owed in September, so there is no date filter: one would drop exactly the oldest " +
    "and most expensive rows off the bottom. Reading it is `party:read`, like the calendar it " +
    "hangs off — everybody on the team should be able to see that six filings have been late " +
    "for a week. DECIDING is a different permission.",
  request: { query: DecisionQueryParams },
  responses: {
    200: {
      description: "The queue",
      content: {
        "application/json": { schema: z.object({ rows: z.array(DecisionRowSchema) }) },
      },
    },
    400: errorResponse("An asOf that is not YYYY-MM-DD"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

const ResolveBody = z.object({
  resolutionOptionId: z.string().uuid().openapi({
    description:
      "One of the firm's own resolution options. A row and not an enum, so the list is the " +
      "firm's to change — and so 'how many late fees did we accept this quarter' is a GROUP BY.",
  }),
  reason: z.string().min(1).openapi({
    description:
      "WHY. Mandatory, and the point of the whole endpoint: in eighteen months nobody " +
      "remembers why a late fee was accepted rather than a provisional filing made, and that " +
      "is the question the client actually asks.",
  }),
});

const resolveRoute = createRoute({
  method: "post",
  path: "/api/v1/obligations/{obligationId}/resolve",
  tags: ["obligations"],
  summary: "Record what the firm decided about a deadline it missed",
  description:
    "Where the obligation goes next is the OPTION's to say, not this call's: an option marked " +
    "`closesWithoutFiling` ends it, and any other sends it back to be filed late — after " +
    "which the ordinary completion path files it, with `daysLate` on the event. A decision is " +
    "never overwritten; a second attempt is refused rather than replacing the first.",
  request: {
    params: z.object({ obligationId: z.string().uuid() }),
    body: { content: { "application/json": { schema: ResolveBody } }, required: true },
  },
  responses: {
    204: { description: "Recorded" },
    400: errorResponse("No reason given"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The role may not decide about a missed deadline"),
    404: errorResponse("No such obligation, or no such resolution option"),
    409: errorResponse(
      "Already decided, not waiting on a decision, or the firm has nowhere for the decision " +
        "to send it",
    ),
  },
});

// ── the firm's own compliance vocabulary (T3.3) ─────────────────────────────
//
// The counterpart of `/work-vocabulary`, and it should have existed since T3.2:
// the states were held as rows precisely so a firm could rename them, and until
// now nothing could. Every "mark another state as the X one" message in this
// module was describing a control that did not exist.

const ObligationStateSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string().openapi({
      description:
        "The firm's stable handle. NEVER compared by any rule in this product — the meaning " +
        "is entirely in the flags, which is what makes renaming safe.",
    }),
    name: z.string(),
    isInitial: z.boolean().openapi({
      description: "Where a newly generated filing starts. At most one, and never none.",
    }),
    isTerminal: z.boolean(),
    needsDecision: z.boolean().openapi({
      description: "A person has to choose what happens next. Puts the row in the queue.",
    }),
    isFiled: z.boolean().openapi({
      description: "Where a filing lands once the work discharging it is finished.",
    }),
    isMissed: z.boolean().openapi({
      description:
        "Where the nightly sweep sends a filing whose statutory date passed undischarged. " +
        "Has to be a state that needs a decision, or the filing would move there and nobody " +
        "would be asked about it.",
    }),
    isResolution: z.boolean().openapi({
      description:
        "Where a filing ends when a partner decides it will never be made. The OTHER terminal " +
        "state — distinct from filed, which is where one lands when it actually was.",
    }),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
  })
  .openapi("ObligationState");

const ResolutionOptionSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    closesWithoutFiling: z.boolean().openapi({
      description:
        "THE FORK. False — 'file provisionally', 'accept the late fee' — means the filing " +
        "still has to happen, so the obligation goes back to be worked and filed late. True — " +
        "'not applicable to this entity' — means it never will, and the obligation ends.",
    }),
    status: RuleStatus.openapi({
      description:
        "The four shipped options came from a previous vendor's app and match what the firm " +
        "described its practice to be — but nobody has confirmed the LIST, so they ship " +
        "'unconfirmed'. Confirming one is a partner saying it is actually theirs.",
    }),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
  })
  .openapi("ResolutionOption");

const vocabularyRoute = createRoute({
  method: "get",
  path: "/api/v1/obligation-vocabulary",
  tags: ["obligations"],
  summary: "The firm's own words for its compliance calendar",
  description:
    "Retired rows are returned on purpose: an admin needs to see what was stopped in order to " +
    "bring it back, and obligations sitting in a retired state still carry it.",
  responses: {
    200: {
      description: "The vocabulary",
      content: {
        "application/json": {
          schema: z.object({
            states: z.array(ObligationStateSchema),
            resolutionOptions: z.array(ResolutionOptionSchema),
          }),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

const StateFlags = {
  isInitial: z.boolean().optional(),
  isTerminal: z.boolean().optional(),
  needsDecision: z.boolean().optional(),
  isFiled: z.boolean().optional(),
  isMissed: z.boolean().optional(),
  isResolution: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
};

const createStateRoute = createRoute({
  method: "post",
  path: "/api/v1/obligation-vocabulary/states",
  tags: ["obligations"],
  summary: "Add a state to the firm's compliance vocabulary",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ code: z.string(), name: z.string(), ...StateFlags }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: ObligationStateSchema } },
    },
    400: errorResponse("A malformed handle or sort order"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The role may not administer the firm"),
    409: errorResponse("That handle is taken, or the flags contradict each other"),
  },
});

const updateStateRoute = createRoute({
  method: "patch",
  path: "/api/v1/obligation-vocabulary/states/{stateId}",
  tags: ["obligations"],
  summary: "Rename, re-flag, reorder or retire a compliance state",
  description:
    "Marking a state as one of the four destinations CLEARS that flag on whoever held it, in " +
    "the same statement — so there is never a moment where the firm has none. What is refused " +
    "is leaving it with none: untick nothing, mark another instead.",
  request: {
    params: z.object({ stateId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            ...StateFlags,
            isActive: z.boolean().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: ObligationStateSchema } },
    },
    400: errorResponse("A malformed sort order"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The role may not administer the firm"),
    404: errorResponse("No such state"),
    409: errorResponse(
      "The flags contradict each other, or this is the last state holding a destination",
    ),
  },
});

const createOptionRoute = createRoute({
  method: "post",
  path: "/api/v1/obligation-vocabulary/resolution-options",
  tags: ["obligations"],
  summary: "Add an answer to the firm's list of what may be decided about a missed deadline",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            code: z.string(),
            name: z.string(),
            closesWithoutFiling: z.boolean().optional(),
            sortOrder: z.number().int().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: ResolutionOptionSchema } },
    },
    400: errorResponse("A malformed handle or sort order"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The role may not administer the firm"),
    409: errorResponse("That handle is taken"),
  },
});

const updateOptionRoute = createRoute({
  method: "patch",
  path: "/api/v1/obligation-vocabulary/resolution-options/{optionId}",
  tags: ["obligations"],
  summary: "Rename, re-point, confirm, reorder or retire a resolution option",
  description:
    "Changing `closesWithoutFiling` affects only decisions taken from then on. Obligations " +
    "already resolved under it keep the state they were moved to, because that is where a " +
    "partner actually sent them.",
  request: {
    params: z.object({ optionId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            closesWithoutFiling: z.boolean().optional(),
            status: RuleStatus.optional(),
            sortOrder: z.number().int().optional(),
            isActive: z.boolean().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: ResolutionOptionSchema } },
    },
    400: errorResponse("A malformed sort order or status"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The role may not administer the firm"),
    404: errorResponse("No such option"),
  },
});

export function registerObligationRoutes(app: OpenAPIHono<AppEnv>, deps: ObligationDeps): void {
  app.openapi(listRulesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const rules = await deps.service.listRules(s.tenantId);
    return c.json({ rules: rules.map(ruleToWire), ruleCount: rules.length }, 200);
  });

  app.openapi(seedRulesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const created = await deps.service.seedIndiaRulePack(s.tenantId, s.actor);
    return c.json({ created }, 200);
  });

  app.openapi(createRuleRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const { rule, effect } = await deps.service.createRule(
      { tenantId: s.tenantId, ...body },
      s.actor,
    );
    const [record] = (await deps.service.listRules(s.tenantId)).filter(
      (r) => r.template.id === rule.id,
    );
    return c.json(
      {
        rule: ruleToWire(
          record ?? unread(rule),
        ),
        effect,
      },
      201,
    );
  });

  app.openapi(listFilingsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const filings = await deps.service.filings(s.tenantId);
    return c.json({ filings: filings.map(ruleToWire) }, 200);
  });

  app.openapi(serviceFilingsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { serviceEntryId } = c.req.valid("param");
    const filings = await deps.service.filingsForService(s.tenantId, serviceEntryId);
    return c.json({ filings: filings.map(ruleToWire) }, 200);
  });

  app.openapi(linkFilingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { serviceEntryId } = c.req.valid("param");
    const { ruleId } = c.req.valid("json");
    const { rule, effect } = await deps.service.linkRule(
      { tenantId: s.tenantId, serviceEntryId, ruleId },
      s.actor,
    );
    // The filing as it now reads, usedIn included, from the same list the
    // catalogue reads, so the card can swap the row in without a reload.
    const record = (await deps.service.filings(s.tenantId)).find(
      (r) => r.template.lineageId === rule.lineageId,
    );
    return c.json(
      {
        rule: ruleToWire(record ?? unread(rule)),
        effect: {
          linked: effect.linked,
          confirmed: effect.confirmed,
          spawned: effect.spawned,
          restored: effect.restored,
          companies: effect.companies,
        },
      },
      200,
    );
  });

  app.openapi(unlinkFilingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { serviceEntryId, ruleId } = c.req.valid("param");
    const { rule, effect } = await deps.service.unlinkRule(
      { tenantId: s.tenantId, serviceEntryId, ruleId },
      s.actor,
    );
    const record = (await deps.service.filings(s.tenantId)).find(
      (r) => r.template.lineageId === rule.lineageId,
    );
    return c.json(
      {
        rule: ruleToWire(record ?? unread(rule)),
        effect: {
          unlinked: effect.unlinked,
          withdrawn: effect.withdrawn,
          kept: effect.kept,
          keptStarted: effect.keptStarted,
          keptPastDue: effect.keptPastDue,
          keptCoveredElsewhere: effect.keptCoveredElsewhere,
        },
      },
      200,
    );
  });

  app.openapi(updateRuleRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { ruleId } = c.req.valid("param");
    const { rule, effect } = await deps.service.updateRule(
      s.tenantId,
      ruleId,
      c.req.valid("json"),
      s.actor,
    );
    const [record] = (await deps.service.listRules(s.tenantId)).filter(
      (r) => r.template.id === ruleId,
    );
    return c.json(
      {
        rule: ruleToWire(
          record ?? unread(rule),
        ),
        effect,
      },
      200,
    );
  });

  app.openapi(supersedeRuleRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { ruleId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { rule, effect } = await deps.service.supersedeRule(
      s.tenantId,
      ruleId,
      {
        effectiveFrom: body.effectiveFrom,
        rulePack: body.rulePack,
        dueRule: body.dueRule,
        unresolvedReason: body.unresolvedReason,
        leadTimeDays: body.leadTimeDays,
        authority: body.authority,
        module: body.module,
        entityType: body.entityType,
      },
      s.actor,
    );
    const [record] = (await deps.service.listRules(s.tenantId)).filter(
      (r) => r.template.id === rule.id,
    );
    return c.json(
      {
        rule: ruleToWire(
          record ?? unread(rule),
        ),
        effect,
      },
      201,
    );
  });

  app.openapi(addExceptionRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { ruleId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { exception: created, effect } = await deps.service.addException(
      s.tenantId,
      ruleId,
      {
        periodEndMonth: body.periodEndMonth,
        kind: body.kind,
        dueMonthOffset: body.dueMonthOffset ?? null,
        dueDayOfMonth: body.dueDayOfMonth ?? null,
        dueDaysAfter: body.dueDaysAfter ?? null,
        note: body.note,
      },
      s.actor,
    );
    return c.json(
      {
        exception: {
          periodEndMonth: created.periodEndMonth,
          kind: created.kind,
          dueMonthOffset: created.dueMonthOffset,
          dueDayOfMonth: created.dueDayOfMonth,
          dueDaysAfter: created.dueDaysAfter,
          note: created.note,
        },
        effect,
      },
      201,
    );
  });

  app.openapi(withdrawExceptionRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { ruleId, periodEndMonth } = c.req.valid("param");
    const effect = await deps.service.removeException(s.tenantId, ruleId, periodEndMonth, s.actor);
    // 200 AND A BODY, not the 204 this was. Withdrawing an exception puts a
    // period back under the rule's own formula, which moves dates that are
    // already on the calendar — and a caller told only "no content" has no way
    // to know that happened.
    return c.json({ effect }, 200);
  });

  app.openapi(calendarRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const rows = await deps.service.calendar(s.tenantId, q);
    // Field by field. A spread would put whatever the read model grows next on
    // the wire without the schema documenting it — and an undocumented field is
    // one the generated frontend client cannot see.
    return c.json(
      {
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          authority: r.authority,
          module: r.module,
          entityPartyId: r.entityPartyId,
          entityName: r.entityName,
          clientName: r.clientName,
          periodLabel: r.periodLabel,
          statutoryDueOn: r.statutoryDueOn,
          internalTargetOn: r.internalTargetOn,
          stateCode: r.stateCode,
          stateName: r.stateName,
          isTerminal: r.isTerminal,
          needsDecision: r.needsDecision,
          workItemId: r.workItemId,
          filedOn: r.filedOn,
          filedByWorkItemId: r.filedByWorkItemId,
          filedByTitle: r.filedByTitle,
          resolutionOptionId: r.resolutionOptionId,
          resolutionName: r.resolutionName,
          resolutionReason: r.resolutionReason,
          resolvedAt: r.resolvedAt,
          ruleUnconfirmed: r.ruleUnconfirmed,
          rulePack: r.rulePack,
        })),
      },
      200,
    );
  });

  app.openapi(coverageRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const gaps = await deps.service.coverage(s.tenantId);
    return c.json(
      {
        gaps: gaps.map((g) => ({
          engagementId: g.engagementId,
          entityPartyId: g.entityPartyId,
          entityName: g.entityName,
          clientName: g.clientName,
          serviceName: g.serviceName,
          jurisdiction: g.jurisdiction,
          reason: g.reason,
          blockedRuleIds: [...g.blockedRuleIds],
        })),
      },
      200,
    );
  });

  app.openapi(decisionQueueRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { asOf } = c.req.valid("query");
    const rows = await deps.service.decisionQueue(s.tenantId);
    // `daysLate` is computed against the CALLER's day, not the server's. G3.2
    // learnt this the hard way: a panel opened at 04:11 in Delhi read the
    // previous day's answer, and here that would understate how late a filing
    // is by one on every row, every morning.
    const today = await deps.service.decisionDay(s.tenantId, asOf);
    return c.json(
      {
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          authority: r.authority,
          module: r.module,
          entityPartyId: r.entityPartyId,
          entityName: r.entityName,
          clientName: r.clientName,
          periodLabel: r.periodLabel,
          statutoryDueOn: r.statutoryDueOn,
          internalTargetOn: r.internalTargetOn,
          daysLate: daysBetween(r.statutoryDueOn, today),
          stateId: r.stateId,
          stateCode: r.stateCode,
          stateName: r.stateName,
          workItemId: r.workItemId,
          ruleUnconfirmed: r.ruleUnconfirmed,
        })),
      },
      200,
    );
  });

  app.openapi(resolveRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { obligationId } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.service.resolve(
      s.tenantId,
      obligationId,
      { optionId: body.resolutionOptionId, reason: body.reason },
      s.actor,
    );
    return c.body(null, 204);
  });

  app.openapi(vocabularyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const [states, options] = await Promise.all([
      deps.vocabulary.listStates(s.tenantId),
      deps.vocabulary.listResolutionOptions(s.tenantId),
    ]);
    return c.json(
      {
        states: states.map(stateToWire),
        resolutionOptions: options.map(optionToWire),
      },
      200,
    );
  });

  app.openapi(createStateRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const state = await deps.vocabulary.createState(
      { tenantId: s.tenantId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(stateToWire(state), 201);
  });

  app.openapi(updateStateRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { stateId } = c.req.valid("param");
    const state = await deps.vocabulary.updateState(
      { tenantId: s.tenantId, stateId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(stateToWire(state), 200);
  });

  app.openapi(createOptionRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const option = await deps.vocabulary.createResolutionOption(
      { tenantId: s.tenantId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(optionToWire(option), 201);
  });

  app.openapi(updateOptionRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { optionId } = c.req.valid("param");
    const option = await deps.vocabulary.updateResolutionOption(
      { tenantId: s.tenantId, optionId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(optionToWire(option), 200);
  });
}

// Field by field, never the domain object: zod-openapi documents a response
// without validating it, so a field on the wire but not in the schema is one
// the generated frontend client cannot see.
function stateToWire(s: ObligationState) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    isInitial: s.isInitial,
    isTerminal: s.isTerminal,
    needsDecision: s.needsDecision,
    isFiled: s.isFiled,
    isMissed: s.isMissed,
    isResolution: s.isResolution,
    sortOrder: s.sortOrder,
    isActive: s.isActive,
  };
}

function optionToWire(o: ResolutionOption) {
  return {
    id: o.id,
    code: o.code,
    name: o.name,
    closesWithoutFiling: o.closesWithoutFiling,
    status: o.status,
    sortOrder: o.sortOrder,
    isActive: o.isActive,
  };
}

export const obligationRoutes = {
  listRules: listRulesRoute,
  seedRules: seedRulesRoute,
  createRule: createRuleRoute,
  updateRule: updateRuleRoute,
  addException: addExceptionRoute,
  withdrawException: withdrawExceptionRoute,
  listFilings: listFilingsRoute,
  serviceFilings: serviceFilingsRoute,
  linkFiling: linkFilingRoute,
  unlinkFiling: unlinkFilingRoute,
  calendar: calendarRoute,
  coverage: coverageRoute,
  decisionQueue: decisionQueueRoute,
  resolve: resolveRoute,
  vocabulary: vocabularyRoute,
  createState: createStateRoute,
  updateState: updateStateRoute,
  createResolutionOption: createOptionRoute,
  updateResolutionOption: updateOptionRoute,
} as const;
