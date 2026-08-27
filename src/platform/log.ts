// A minimal structured-logger port. The api layer maps and logs errors through
// this, so it never depends on a concrete logger (pino) directly. pino's Logger
// satisfies it structurally, so the composition root passes pino straight in.
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}
