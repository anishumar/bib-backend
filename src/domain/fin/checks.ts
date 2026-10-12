// The fixed-rule checks, lane `rule` (docs/FIN_BUILD_PLAN.md F4.3, F4.5): the
// shapes they take, and the one call that runs them all. Pure.
//
// Ground rule 1: rules and arithmetic decide. A check reads COMMITTED lines
// (what a person accepted in staging, F2.8), the client's facts and the dated
// law (`RuleParameters`), and says "check this" as a `FindingDraft`. It never
// changes a line, never decides what a finding means, and never reads the
// training pack's answer key.
//
// ── WHICH LINES A RUN IS GIVEN ──────────────────────────────────────────────
//
// `lines` are the lines received FOR the period being checked (a month's close,
// or a year), whatever their own dates say: a document dated in December that
// arrives with January's files is exactly what the cut-off check is for, so the
// caller does not select lines by date. `history` is the client's earlier
// committed lines, read only to recognise a duplicate or the invoice a credit
// note refers to; no history line is checked again.
//
// ── EVERY FINDING IS RAISED ONCE ────────────────────────────────────────────
//
// Each `dedupeKey` is built from the firm's own line ids and the check, so the
// same checks over the same lines produce the same keys and the store raises
// nothing new (`fin.finding_once`). A key never holds a name: it is a column a
// person never reads, and a counterparty may be a person.
import type { FindingDraft } from "./finding";
import { checkDocuments } from "./checks-documents";
import { checkPayroll } from "./checks-payroll";
import type { CheckPeriod, CheckedDocumentLine, CheckedPayrollLine, ClientFacts } from "./checks-input";
import type { RuleParameters } from "./parameters";

export type {
  CheckPeriod,
  CheckedDocumentLine,
  CheckedPayrollLine,
  ClientFacts,
  DocumentCheckInput,
  PayrollCheckInput,
} from "./checks-input";

export interface RuleCheckInput {
  readonly client: ClientFacts;
  readonly period: CheckPeriod;
  readonly documents: readonly CheckedDocumentLine[];
  readonly payroll: readonly CheckedPayrollLine[];
  readonly documentHistory?: readonly CheckedDocumentLine[];
  readonly payrollHistory?: readonly CheckedPayrollLine[];
  readonly parameters: RuleParameters;
}

/** Every lane-`rule` check over one client's period, in a stable order. */
export function ruleChecks(input: RuleCheckInput): FindingDraft[] {
  return [
    ...checkDocuments({
      client: input.client,
      period: input.period,
      lines: input.documents,
      history: input.documentHistory ?? [],
      parameters: input.parameters,
    }),
    ...checkPayroll({
      client: input.client,
      period: input.period,
      lines: input.payroll,
      history: input.payrollHistory ?? [],
      parameters: input.parameters,
    }),
  ];
}
