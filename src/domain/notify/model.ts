// Notifications — what one colleague is told, and how it reads (0323).
//
// Pure: the category registry, the channel rule, the dedupe keys and the
// renderer. Nothing here knows where a row came from or how it travels.
//
// ── THE REGISTRY IS CODE, LIKE THE LEDGER'S VERBS ──────────────────────────
//
// A category is three things at once: who receives it (a rule in the fan-out),
// what it says (the renderer below) and what the firm may switch off. None of
// those is a row a firm can type, so the list is closed and reviewed like code.
// The firm's part is data: which categories are on, and on which channels
// (`notify.firm_default`), and each person's own overrides on top
// (`notify.user_preference`).
//
// ── THE SENTENCE IS RENDERED FOR THE READER ────────────────────────────────
//
// `payload` holds ids and machine facts; names are joined when the row is read.
// `renderNotification` takes the reader's fee visibility, so an amount reaches
// only somebody whose membership lets them see fees. That is the fifth axis
// applied exactly as `AuthzService.withFeeVisibility` applies it: the row is
// still shown, without the money.
import { displayMoney } from "../money/model";

export const NOTIFY_CHANNELS = ["in_app", "email", "push"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export function isNotifyChannel(v: string): v is NotifyChannel {
  return (NOTIFY_CHANNELS as readonly string[]).includes(v);
}

export interface CategorySpec {
  /** What the preferences screen calls it. Plain words, no codes. */
  readonly label: string;
  /** Where it sits on the preferences screen. */
  readonly group: "work" | "clients" | "billing" | "deadlines";
  /**
   * The in-app half cannot be switched off, by the firm or by the person. These
   * are the two that exist to stop a client losing money; a bell somebody
   * silenced is the escalation ladder made decoration.
   */
  readonly mandatoryInApp: boolean;
  /** The product's default per channel, before any firm or person changes it. */
  readonly defaults: Readonly<Record<NotifyChannel, boolean>>;
}

const ON_IN_APP = { in_app: true, email: false, push: false } as const;
const ON_IN_APP_AND_EMAIL = { in_app: true, email: true, push: false } as const;

/**
 * Every category, in the order the preferences screen lists them.
 *
 * The defaults are the user's recommendation to Ashish (DESIGN.md, 2026-10-03):
 * everything in the bell; email only for the two that cost a client money.
 * Every firm may change all of it except the two mandatory bells.
 */
export const NOTIFY_CATEGORIES = {
  task_assigned:     { label: "A task is given to you",                group: "work",      mandatoryInApp: false, defaults: ON_IN_APP },
  step_assigned:     { label: "A step is given to you",                group: "work",      mandatoryInApp: false, defaults: ON_IN_APP },
  check_requested:   { label: "Work is sent to you to check",          group: "work",      mandatoryInApp: false, defaults: ON_IN_APP },
  escalation:        { label: "Work is escalated to you",              group: "work",      mandatoryInApp: true,  defaults: ON_IN_APP_AND_EMAIL },
  lead_assigned:     { label: "A lead is given to you",                group: "clients",   mandatoryInApp: false, defaults: ON_IN_APP },
  client_request:    { label: "A client sends a request or a reply",   group: "clients",   mandatoryInApp: false, defaults: ON_IN_APP },
  client_answered:   { label: "A client answers what you asked for",   group: "clients",   mandatoryInApp: false, defaults: ON_IN_APP },
  proposal_decided:  { label: "A client accepts or declines a proposal", group: "clients", mandatoryInApp: false, defaults: ON_IN_APP },
  letter_signed:     { label: "A client signs an engagement letter",   group: "clients",   mandatoryInApp: false, defaults: ON_IN_APP },
  bill_to_raise:     { label: "A bill is ready to raise",              group: "billing",   mandatoryInApp: false, defaults: ON_IN_APP },
  advance_reminder:  { label: "An advance is overdue",                 group: "billing",   mandatoryInApp: false, defaults: ON_IN_APP },
  advance_summary:   { label: "The weekly advances summary",           group: "billing",   mandatoryInApp: false, defaults: ON_IN_APP },
  payment_received:  { label: "A payment is received",                 group: "billing",   mandatoryInApp: false, defaults: ON_IN_APP },
  dunning_decision:  { label: "An overdue invoice needs your decision", group: "billing",  mandatoryInApp: false, defaults: ON_IN_APP },
  filing_missed:     { label: "A filing deadline is missed",           group: "deadlines", mandatoryInApp: true,  defaults: ON_IN_APP_AND_EMAIL },
} as const satisfies Record<string, CategorySpec>;

export type NotifyCategory = keyof typeof NOTIFY_CATEGORIES;

export function isNotifyCategory(v: string): v is NotifyCategory {
  return Object.prototype.hasOwnProperty.call(NOTIFY_CATEGORIES, v);
}

export const NOTIFY_CATEGORY_KEYS = Object.keys(NOTIFY_CATEGORIES) as NotifyCategory[];

/**
 * Whether a category reaches a person on a channel.
 *
 * The person's own choice wins, then the firm's, then the product's — the order
 * every settings screen in this market uses. The one exception is the mandatory
 * bell, which no override reaches: a firm switching off "filing missed" in the
 * bell would make the one warning that protects a client's money optional.
 */
export function channelEnabled(
  category: NotifyCategory,
  channel: NotifyChannel,
  firm: boolean | undefined,
  person: boolean | undefined,
): boolean {
  const spec: CategorySpec = NOTIFY_CATEGORIES[category];
  if (channel === "in_app" && spec.mandatoryInApp) return true;
  return person ?? firm ?? spec.defaults[channel];
}

/** Whether anybody may switch this category off on this channel. */
export function isLocked(category: NotifyCategory, channel: NotifyChannel): boolean {
  const spec: CategorySpec = NOTIFY_CATEGORIES[category];
  return channel === "in_app" && spec.mandatoryInApp;
}

// ── dedupe keys ─────────────────────────────────────────────────────────────
//
// Unique per (firm, recipient, key). The two shapes say what "the same
// notification" means for each writer.

/** An outbox row: this event, told to this person, once per category. */
export function eventDedupeKey(eventId: string, category: NotifyCategory): string {
  return `event:${eventId}:${category}`;
}

/**
 * A reminder: this source reaching this STAGE, once. A sweep that runs every
 * hour for a fortnight writes one row per stage it saw, never one per run.
 */
export function stageDedupeKey(category: NotifyCategory, sourceId: string, stage: string): string {
  return `stage:${category}:${sourceId}:${stage}`;
}

// ── links ───────────────────────────────────────────────────────────────────

/**
 * Where a notification opens, as a path on the web app.
 *
 * One mapping, read by the bell and by the email (which puts the web origin in
 * front), so the two cannot disagree about where a thing lives. A source with
 * no page of its own opens the list it sits on.
 */
export function notificationPath(
  category: NotifyCategory,
  sourceType: string,
  sourceId: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  switch (sourceType) {
    case "work_item":
      return `/work-items/${sourceId}`;
    case "job":
      return `/work/${sourceId}`;
    case "client_request":
      return `/client-requests/${sourceId}`;
    case "lead":
      return `/leads/${sourceId}`;
    case "proposal":
      return `/proposals/${sourceId}`;
    case "engagement_letter": {
      // An advance reminder is about the money, and the invoice is where it is
      // issued or chased; without one, the Advances list.
      if (category === "advance_reminder") {
        const invoiceId = text(payload, "invoiceId");
        return invoiceId === null ? "/invoices?tab=advances" : `/invoices/${invoiceId}`;
      }
      return `/engagement-letters/${sourceId}`;
    }
    case "invoice":
      return category === "dunning_decision" ? "/receivables" : `/invoices/${sourceId}`;
    case "billing_due":
      return "/invoices?tab=raise";
    case "obligation_instance":
      return "/calendar";
    case "tenant":
      return category === "advance_summary" ? "/invoices?tab=advances" : "/";
    default:
      return "/";
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

/** What the read joins in, so the sentence can name things. */
export interface RenderInput {
  readonly category: NotifyCategory;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Who did it, as a person reads them: the name, else the email. */
  readonly actorName: string | null;
  readonly clientName: string | null;
  /** The thing itself: a task's title, a proposal's reference, an invoice number. */
  readonly subjectLabel: string | null;
}

export interface Rendered {
  /** One line, what happened. */
  readonly title: string;
  /** One line under it, what it is about. Null when the title says it all. */
  readonly detail: string | null;
}

/**
 * The words of one notification, for one reader.
 *
 * Short, active, second person, no codes and no em dashes: the screen rules in
 * the frontend's CLAUDE.md ("Writing for the screen"). The detail line is the
 * subject and the client, joined by " · ", leaving out whichever is missing.
 */
export function renderNotification(n: RenderInput, seesFees: boolean): Rendered {
  const p = n.payload;
  const about = joinParts(n.subjectLabel, n.clientName);
  const by = n.actorName;
  const money = seesFees ? moneyOf(p) : null;

  switch (n.category) {
    case "task_assigned":
      return { title: by === null ? "A task is on your desk" : `${by} gave you a task`, detail: about };

    case "step_assigned":
      return {
        title: by === null ? "A step is on your desk" : `${by} gave you a step`,
        detail: joinParts(text(p, "stepLabel") ?? text(p, "stepKey"), about),
      };

    case "check_requested":
      return { title: by === null ? "Work is waiting for your check" : `${by} sent you work to check`, detail: about };

    case "escalation": {
      const watch = text(p, "watch");
      const days = int(p, "daysPast");
      const title =
        watch === "work_item_unassigned"
          ? "Escalated: a task nobody has picked up"
          : watch === "obligation_target"
            ? "Escalated: a filing is past its internal date"
            : days !== null && days > 0
              ? `Escalated: a task is ${dayCount(days)} overdue`
              : "Escalated: a task is overdue";
      return { title, detail: about };
    }

    case "lead_assigned":
      return { title: by === null ? "A lead is on your desk" : `${by} gave you a lead`, detail: about };

    case "client_request":
      return {
        title:
          text(p, "stage") === "replied"
            ? `${n.clientName ?? "A client"} replied to a request`
            : "A client request is on your desk",
        detail: text(p, "stage") === "replied" ? n.subjectLabel : about,
      };

    case "client_answered":
      return { title: `${n.clientName ?? "A client"} answered what you asked for`, detail: n.subjectLabel };

    case "proposal_decided": {
      const accepted = text(p, "decision") !== "rejected";
      return {
        title: `${n.clientName ?? "The client"} ${accepted ? "accepted" : "declined"} a proposal`,
        detail: n.subjectLabel,
      };
    }

    case "letter_signed":
      return { title: `${n.clientName ?? "The client"} signed an engagement letter`, detail: n.subjectLabel };

    case "bill_to_raise":
      return {
        title: "A bill is ready to raise",
        detail: joinParts(n.clientName, text(p, "periodLabel"), money),
      };

    case "advance_reminder": {
      const stage = text(p, "stage");
      const title =
        stage === "escalated"
          ? "An advance is still unpaid a week after signing"
          : stage === "unpaid_overdue"
            ? "An advance invoice is overdue"
            : "An advance invoice is still a draft";
      return { title, detail: joinParts(n.clientName, n.subjectLabel, money) };
    }

    case "advance_summary": {
      const count = int(p, "advances") ?? 0;
      return {
        title: "This week's advances summary",
        detail: count === 1 ? "1 advance not paid yet" : `${String(count)} advances not paid yet`,
      };
    }

    case "payment_received":
      return {
        title: `Payment received from ${n.clientName ?? "a client"}`,
        detail: joinParts(n.subjectLabel, money),
      };

    case "dunning_decision":
      return { title: "An overdue invoice needs your decision", detail: about };

    case "filing_missed":
      return { title: "A filing deadline was missed", detail: about };
  }
}

/** The amount on a payload, written for a person, or null when there is none. */
function moneyOf(p: Readonly<Record<string, unknown>>): string | null {
  const amount = text(p, "amount");
  const currency = text(p, "currency");
  if (amount === null || currency === null) return null;
  return displayMoney(amount, currency);
}

function dayCount(days: number): string {
  return days === 1 ? "1 day" : `${String(days)} days`;
}

function joinParts(...parts: readonly (string | null)[]): string | null {
  const kept = parts.filter((s): s is string => s !== null && s.trim() !== "");
  return kept.length === 0 ? null : kept.join(" · ");
}

function text(p: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = p[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function int(p: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = p[key];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}
