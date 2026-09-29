// Sentinel errors for rendering (T3.8). Matched with `instanceof`, mapped to
// HTTP in api/domainerr.ts — where a new code is a compile error until it is.

export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type RenderErrorCode =
  | "UNRENDERABLE_TEXT"
  | "NOT_RENDERABLE"
  | "SOURCE_NOT_FOUND"
  | "NOT_CALLERS_TODAY"
  | "COPY_ALREADY_MADE";

/**
 * The document contains a character the current renderer cannot draw.
 *
 * THE HONEST LIMIT OF THE FONT CHAIN, surfaced rather than worked around.
 *
 * T3.9 embedded Noto Sans as latin + latin-ext + devanagari, so the rupee sign,
 * Devanagari and Latin-Extended all draw now, and Noto Sans Math and Symbols 2
 * joined on 2026-09-29 for ≤ ≥ ✓ ⚠ and their kind. What is still outside it is
 * colour emoji, CJK and every other script the chain does not carry — and
 * adding one is another font in the chain (infrastructure/render/font-set.ts),
 * not a change of approach.
 *
 * The message is read by the person who pressed Preview or Send, not by a
 * developer, so it says what to do in their terms: the field, the character,
 * and that ordinary text in its place will print.
 *
 * Two things were rejected in favour of this error. **Silently dropping the
 * character** would put a client's name on a legal document with a letter
 * missing, which is worse than not producing the document at all. **Substituting
 * a similar one** is the same fault with extra confidence.
 *
 * The message names the character and its position so somebody can actually act
 * — and the real fix, embedding a Unicode font, is on the board.
 */
export class UnrenderableText extends RenderError {
  constructor(field: string, character: string) {
    const code = character.codePointAt(0) ?? 0;
    super(
      "UNRENDERABLE_TEXT",
      `${field} contains ${JSON.stringify(character)} (U+${code.toString(16).toUpperCase().padStart(4, "0")}), ` +
        `a character the PDF cannot print. It prints English and other Latin-script ` +
        `languages, Devanagari, the rupee sign and common symbols such as ≤ ≥ ✓ → ⚠, but not ` +
        `emoji or scripts such as Chinese or Arabic. Nothing is wrong with the record: put ` +
        `ordinary text in place of this character and try again.`,
    );
  }
}

export class NotRenderable extends RenderError {
  constructor(kind: string, known: readonly string[]) {
    super(
      "NOT_RENDERABLE",
      `There is no way to render a ${JSON.stringify(kind)} yet. Renderable today: ${known.join(", ")}.`,
    );
  }
}

export class SourceNotFound extends RenderError {
  constructor(kind: string, ref: string) {
    super("SOURCE_NOT_FOUND", `No ${kind} ${JSON.stringify(ref)} at this firm`);
  }
}

/**
 * A preview asked to be dated on a day that cannot be today anywhere (a
 * preview dates a draft as Send will, and Send holds `asOf` to the firm's day
 * or one either side — `isCallersToday`).
 */
export class PreviewNotCallersToday extends RenderError {
  constructor(given: string, firmDay: string) {
    super(
      "NOT_CALLERS_TODAY",
      `The day sent as asOf, ${JSON.stringify(given)}, cannot be today where you are: the firm's ` +
        `day is ${firmDay}, and anywhere in the world today is that day or the one either side.`,
    );
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-29" as "29 Sep 2026", the way every date on the screens reads. */
function readableDay(day: string): string {
  const [y, m, d] = day.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/**
 * A second PDF of an invoice that was issued, or a letter that was sent
 * (2026-09-29). The first copy made once it went out is the copy of record;
 * see `hasCopyOfRecord` for why it is never drawn again.
 */
export class CopyAlreadyMade extends RenderError {
  constructor(kind: "invoice" | "engagement_letter", reference: string, madeOn: string) {
    super(
      "COPY_ALREADY_MADE",
      kind === "invoice"
        ? `${reference} already has its issued copy, made on ${readableDay(madeOn)}. An issued ` +
            `invoice does not change, so no second copy is made. To correct it, raise a credit ` +
            `note and a new invoice.`
        : `${reference} already has its copy as sent, made on ${readableDay(madeOn)}. A letter ` +
            `that went out does not change, so no second copy is made.`,
    );
  }
}
