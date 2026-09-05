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
 * THE HONEST LIMIT OF THE FONT CHAIN, surfaced rather than worked around.
 *
 * T3.9 embedded Noto Sans as latin + latin-ext + devanagari, so the rupee sign,
 * Devanagari and Latin-Extended all draw now. What is still outside it is CJK
 * and every script the chain does not carry — and adding one is another font in
 * the chain, not a change of approach.
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
        `which none of this renderer's fonts can draw. It carries Noto Sans in Latin, ` +
        `Latin-Extended and Devanagari — so accents, the rupee sign and Devanagari are all ` +
        `fine, and this character is outside all three. This is a limit of the renderer, not ` +
        `of the data: nothing is wrong with the record. Supporting it means adding a font to ` +
        `the chain in infrastructure/render/font-set.ts.`,
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
