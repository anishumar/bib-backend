// Whose kitty a bill goes in, asked the same way by every kind of bill: the
// period sweep (0318), the advance and the final bill (0320). The rule itself
// is `resolveBillingManager` in the domain; this is the asking.
import type { BillingManager } from "../../domain/billing/model";
import { resolveBillingManager } from "../../domain/billing/model";
import type { BillingManagerFacts } from "./ports";

/** A per-pass cache, so one client's Depts are asked once. */
export type ManagerCache = Map<string, Promise<BillingManager>>;

/**
 * The manager for a bill of this client covering work filed under these Depts
 * (null = a service filed under none). One Dept with SPOCs who all report to
 * one person is that person; anything else goes to the client's Key Manager
 * with a sentence saying why.
 */
export function billingManagerFor(
  facts: BillingManagerFacts,
  input: {
    readonly tenantId: string;
    readonly partyId: string;
    readonly deptCodes: readonly (string | null)[];
    readonly today: string;
  },
  cache: ManagerCache = new Map(),
): Promise<BillingManager> {
  const deptCodes = [...new Set(input.deptCodes.filter((d): d is string => d !== null))].sort();
  // A service filed under no Dept says so in the rule's own words, so it is
  // part of the key: one under no Dept beside one under FRC is not "FRC".
  const unfiled = input.deptCodes.some((d) => d === null);
  const key = `${input.partyId}|${deptCodes.join(",")}|${String(unfiled)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const answer = (async () => {
    const codes = unfiled && deptCodes.length > 0 ? [...deptCodes, "(no Dept)"] : deptCodes;
    const [dept] = deptCodes;
    const spocs =
      codes.length === 1 && dept !== undefined
        ? await facts.spocsFor(input.tenantId, input.partyId, dept, input.today)
        : [];
    const keyManager = await facts.keyManagerFor(input.tenantId, input.partyId, input.today);
    return resolveBillingManager({ deptCodes: codes, spocs, keyManager });
  })();
  cache.set(key, answer);
  return answer;
}
