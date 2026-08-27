// The id generator every module's fakes share.
//
// It lives in its own file because it belongs to no single module: putting it
// beside the tenancy fakes made the ledger fakes import tenancy and tenancy
// import the ledger, which the no-circular rule caught — correctly. A cycle
// means the two files are really one, and the shared piece was this.
import type { IdGen } from "../platform/ids";

/** Deterministic ids that are still SHAPED like the real ones. They must be
 *  valid uuids: the ledger validates every id it is given, so a fake producing
 *  "id-1" would fail there while passing everywhere else — a fake that lies
 *  about shape only postpones the bug. */
export class FakeIds implements IdGen {
  private n = 0;
  private readonly derived = new Map<string, string>();

  newId(): string {
    this.n += 1;
    return sequentialUuid(this.n);
  }

  /** Same (namespace, key) yields the same id, which is the only property
   *  callers depend on — it is what makes a replayed callback idempotent. */
  derivedId(namespace: string, key: string): string {
    const composite = `${namespace}:${key}`;
    const existing = this.derived.get(composite);
    if (existing !== undefined) return existing;
    const id = sequentialUuid(9000 + this.derived.size);
    this.derived.set(composite, id);
    return id;
  }
}

function sequentialUuid(n: number): string {
  const tail = String(n).padStart(12, "0");
  return `00000000-0000-4000-8000-${tail}`;
}
