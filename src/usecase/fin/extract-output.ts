// Is the model's answer a reading at all? (docs/FIN_BUILD_PLAN.md F2.4)
//
// Strict tool use makes the provider return input that matches the tool's JSON
// schema, and this checks it anyway, for three reasons: strict mode cannot say
// "0 to 1" (it takes no numeric bounds), it cannot tie a field's value to its
// status, and a schema the provider enforces today is still input from outside
// this program. Anything this refuses is retried once with the problems named,
// then goes to a person as `ai_invalid_output`.
//
// zod lives here and not in the domain, which is stdlib only (CLAUDE.md); the
// shapes it checks are the domain's (`DOC_CLASSES`, `FIELD_STATUSES`,
// `READ_FIELDS`), so the schema the model is given and the one this enforces
// are built from one list.
import { z } from "zod";
import { DOC_CLASSES, FIELD_STATUSES, READ_FIELDS } from "../../domain/fin/extraction";
import type { DocumentReading, ReadField } from "../../domain/fin/extraction";

const confidence = z.number().finite().min(0, "must be at least 0").max(1, "must be at most 1");

const fieldReading = z
  .object({
    value: z.string().nullable(),
    status: z.enum(FIELD_STATUSES),
    confidence,
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.status === "read" && (f.value === null || f.value.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status is read, so value must be the text as printed",
      });
    }
    if (f.status !== "read" && f.value !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status is ${f.status}, so value must be null`,
      });
    }
  });

const fieldShape = Object.fromEntries(READ_FIELDS.map((f) => [f, fieldReading])) as Record<
  ReadField,
  typeof fieldReading
>;

const documentReading = z
  .object({
    docType: z.enum(DOC_CLASSES),
    docTypeConfidence: confidence,
    fields: z.object(fieldShape).strict(),
    overallConfidence: confidence,
  })
  .strict();

/** At most this many problems go back to the model, each at most this long. */
const MAX_PROBLEMS = 12;
const MAX_PROBLEM_LENGTH = 200;

export type ParsedReading =
  | { readonly ok: true; readonly reading: DocumentReading }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The tool input as a `DocumentReading`, or what is wrong with it as short
 * sentences ("fields.total.confidence: must be at most 1"). The sentences name
 * paths and rules and never repeat a value, so the retry sends nothing back
 * that the document did not already say.
 */
export function parseDocumentReading(output: unknown): ParsedReading {
  const parsed = documentReading.safeParse(output);
  if (parsed.success) return { ok: true, reading: parsed.data };
  const problems = parsed.error.issues.slice(0, MAX_PROBLEMS).map((issue) => {
    const where = issue.path.length === 0 ? "the input" : issue.path.join(".");
    return `${where}: ${issue.message}`.slice(0, MAX_PROBLEM_LENGTH);
  });
  return { ok: false, problems };
}
