// A credential read from the environment, held so that printing it by accident
// prints nothing (F2.4: the Anthropic API key is "never logged, never in an
// error message").
//
// The value lives in a private field, so `JSON.stringify` (what pino does to a
// logged object), `util.inspect` (what `console.log` does) and a template
// string all see `[redacted]`. Only `reveal()` hands the value over, and its one
// caller is the composition root building the adapter that sends it.
//
// It is a guard against the ACCIDENT, not against code that means to read the
// value: `redacted()` in config.ts still masks the field explicitly, and the
// adapter never puts the key in anything it returns.

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The credential itself. Call it where it is sent, nowhere else. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [INSPECT](): string {
    return "[redacted]";
  }
}
