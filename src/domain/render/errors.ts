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

export type RenderErrorCode = "UNRENDERABLE_TEXT" | "NOT_RENDERABLE" | "SOURCE_NOT_FOUND";

/**
 * The document contains a character the current renderer cannot draw.
 *
 * THE HONEST LIMIT OF THE PDF ENGINE, surfaced rather than worked around. The
 * standard PDF fonts use WinAnsi, which covers Latin-1 and no more — so the
 * rupee sign, Devanagari, Chinese characters and the em dash in some positions
 * are all outside it.
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
        `which the built-in PDF fonts cannot draw — they cover Latin-1 and no more. This is a ` +
        `limit of the current renderer, not of the data: nothing is wrong with the record. ` +
        `Amounts are written with their ISO code (INR 1,000.00) rather than a currency symbol ` +
        `for exactly this reason. Embedding a Unicode font is the real fix and is on the board.`,
    );
  }
}

export class NotRenderable extends RenderError {
  constructor(kind: string, known: readonly string[]) {
    super(
      "NOT_RENDERABLE",
      `there is no way to render a ${JSON.stringify(kind)} yet. Renderable today: ${known.join(", ")}.`,
    );
  }
}

export class SourceNotFound extends RenderError {
  constructor(kind: string, ref: string) {
    super("SOURCE_NOT_FOUND", `no ${kind} ${JSON.stringify(ref)} at this firm`);
  }
}
