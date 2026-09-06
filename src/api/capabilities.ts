// What each /internal route requires, and the capability vocabulary itself.
//
// The provisioning surface authenticates but, until now, did not authorize: one
// shared secret opened every route on it. That is an escalation path, not a
// theoretical one — create a user, grant them partner in any firm, set their
// password, sign in as them. Three calls, one key.
//
// So the key stops being a password and becomes an identity: each caller has
// its own, carrying only the capabilities it needs. Same shape as
// ROUTE_PERMISSIONS on the product surface, for the same reason — a central
// table, denied by default, so a new route is refused until someone decides who
// may call it.
import { routeKey } from "./permissions";
import type { RouteKey } from "./permissions";

/**
 * What a provisioning caller may do. Deliberately coarse — one per genuinely
 * distinct act, not one per endpoint.
 */
export type Capability =
  | "tenant.provision"
  | "user.provision"
  | "membership.grant"
  | "credential.set";

export const CAPABILITIES: readonly Capability[] = [
  "tenant.provision",
  "user.provision",
  "membership.grant",
  "credential.set",
];

export function isCapability(v: string): v is Capability {
  return (CAPABILITIES as readonly string[]).includes(v);
}

/**
 * `credential.set` is the one that grants a LOGIN AS somebody.
 *
 * The other three shape the world; this one hands over an identity. Held
 * alongside `user.provision` and `membership.grant` it completes the
 * escalation path above, which is why validate.ts refuses to boot a
 * production-like environment where one key holds it together with anything
 * else. Named here so the rule and its reason live with the vocabulary.
 */
export const IDENTITY_GRANTING: Capability = "credential.set";

/** The capability each provisioning route requires. Unlisted ⇒ refused. */
export const ROUTE_CAPABILITIES: ReadonlyMap<RouteKey, Capability> = new Map([
  [routeKey("POST", "/internal/v1/tenants"), "tenant.provision" as const],
  [routeKey("POST", "/internal/v1/users"), "user.provision" as const],
  [routeKey("POST", "/internal/v1/memberships"), "membership.grant" as const],
  [routeKey("PUT", "/internal/v1/users/{userId}/password"), "credential.set" as const],
  // Suspending a firm and disabling a login are the two controls that STOP
  // things, and each sits with the capability that CREATED the thing it stops:
  // whoever may bring a firm into existence may take it out of service, and the
  // same for an account. Neither needs `credential.set`, which is the one that
  // hands over a login and is deliberately held alone.
  [routeKey("PUT", "/internal/v1/tenants/{tenantId}/status"), "tenant.provision" as const],
  [routeKey("PUT", "/internal/v1/users/{userId}/status"), "user.provision" as const],
]);

/** A named caller and what it is trusted with. */
export interface InternalClient {
  /** Identifies the caller in logs and in the audit trail. Not a secret. */
  readonly name: string;
  readonly key: string;
  readonly capabilities: readonly Capability[];
}

interface CompiledRoute {
  readonly method: string;
  readonly pattern: RegExp;
  readonly literal: boolean;
  readonly capability: Capability;
}

const COMPILED: readonly CompiledRoute[] = [...ROUTE_CAPABILITIES]
  .map(([key, capability]) => {
    const [method = "", path = ""] = key.split(" ");
    const source = path
      .split("/")
      .map((segment) =>
        segment.startsWith("{") && segment.endsWith("}")
          ? "[^/]+"
          : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/");
    return {
      method,
      pattern: new RegExp(`^${source}$`),
      literal: !path.includes("{"),
      capability,
    };
  })
  .sort((a, b) => Number(b.literal) - Number(a.literal));

/** The capability this request needs, or null if the route declares none —
 *  which the guard treats as a refusal, never as a pass. */
export function capabilityFor(method: string, path: string): Capability | null {
  const wanted = method.toUpperCase();
  for (const route of COMPILED) {
    if (route.method === wanted && route.pattern.test(path)) return route.capability;
  }
  return null;
}
