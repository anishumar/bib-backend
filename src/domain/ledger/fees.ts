// Money in the audit trail, and who may read it (B08, audit 2026-10-03).
// Pure, stdlib only.
//
// The timeline (`GET /events`, `GET /objects/{type}/{id}/events`) handed every
// payload to anybody holding `ledger:read`, and a dozen verbs carry a figure:
// what was paid, credited, billed, taken off an advance, still owed. A manager
// without fee visibility opened a client's timeline and read every payment.
//
// The payload stays as it was written (the log is append-only, and a figure in
// it is a fact, not personal data). What changes is the READ: for a login that
// cannot see fees, each field named below is null on the way out, the way the
// fee axis redacts everywhere else. Nulled and not dropped, so "you may not see
// this" never looks like "there was no amount".
//
// NAMED PER VERB, never guessed from key names: a guess would one day miss a
// `remaining` or null an `advanceRequired` that is a yes or no. A new verb that
// carries money is added here; `tests/ledger/fees.test.ts` reads every
// `recordEvent` in the source and fails on a money-shaped key nobody named.
//
// INCLUDED, and why each is money:
//   * amounts paid, credited, billed, owed or left over;
//   * an exchange RATE (`fxRate`): the invoice and the proposal null theirs for
//     the same login, because a rate with a currency turns any figure into
//     another;
//   * a DISCOUNT percentage on a proposal: a proposal's line nulls its
//     discount for that login, so the timeline does too. The firm's LIMIT
//     (`limitPercent`) is not here: it is the firm's published policy, which
//     that login reads on the catalogue anyway.
// A tax RATE is not here: it is not an amount (billing.ts says the same).

import type { EventVerb } from "./model";

export const MONEY_IN_PAYLOAD: Readonly<Partial<Record<EventVerb, readonly string[]>>> = {
  "payment.recorded": ["amount", "tdsAmount"],
  "credit_note.issued": ["amount"],
  "dunning.escalated": ["outstanding"],
  "billing_due.covered": ["advanceApplied"],
  "billing_due.invoiced": ["advanceApplied", "letterAmount", "billedAmount"],
  "billing_due.refund_kept": ["remaining"],
  "advance_allocation.mapped": ["amount"],
  "advance_allocation.ended": ["kept", "freed"],
  // Not written since 0322; old rows still carry the advance received.
  "engagement_letter.advance_recorded": ["amount"],
  "engagement_letter.currency_changed": ["fromFxRate", "toFxRate"],
  "proposal.currency_changed": ["fromFxRate", "toFxRate"],
  "proposal.rate_set": ["fxRate"],
  "engagement_letter.rate_set": ["fxRate"],
  "proposal.drafted": ["fxRate"],
  "invoice.raised": ["fxRate"],
  "lead.details_changed": ["estimatedValueFrom", "estimatedValueTo"],
  "proposal.sent": ["largestDiscountPercent"],
  "proposal.discount_approved": ["largestDiscountPercent"],
  "proposal.discount_approval_lapsed": ["discountPercent"],
};

/**
 * A payload as a login that cannot see fees reads it: the verb's money fields
 * null, everything else as recorded. A new object; the event is never touched.
 * A verb with no money, or one this table has never heard of, is returned as
 * it was.
 */
export function payloadWithoutFees(
  verb: string,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const fields = (MONEY_IN_PAYLOAD as Readonly<Record<string, readonly string[] | undefined>>)[verb];
  const out: Record<string, unknown> = { ...payload };
  if (fields === undefined) return out;
  for (const field of fields) {
    if (field in out) out[field] = null;
  }
  return out;
}
