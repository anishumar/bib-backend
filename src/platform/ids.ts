// Id generation as a port. Two kinds:
//   • newId()      — a fresh random v4, for new aggregates.
//   • derivedId()  — a deterministic v5 from (namespace, key), so a retried
//                    webhook or a racing pod maps back to the SAME row instead
//                    of duplicating. This is how idempotency is done here.
//
// If two services (or two languages) derive ids for the same rows, the
// namespace constant MUST be byte-identical across both, with a cross-repo
// comment. Getting it wrong writes to a non-existent row — no error, just
// missing data.
import { randomUUID } from "node:crypto";
import { v5 as uuidv5 } from "uuid";

export interface IdGen {
  newId(): string;
  derivedId(namespace: string, key: string): string;
}

export const systemIds: IdGen = {
  newId: () => randomUUID(),
  derivedId: (namespace, key) => uuidv5(key, namespace),
};
