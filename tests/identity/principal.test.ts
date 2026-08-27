// The edge's half of authentication: pulling a bearer token out of a request,
// and the two registered resolvers. Pure header parsing, no service, no server.
import { describe, expect, it } from "vitest";
import { devHeaderResolver, firstOf, tokenFrom } from "../../src/api/principal";
import type { PrincipalResolver } from "../../src/api/principal";

const COOKIE = "bib_session";

/** Turns a plain object into the header accessor the resolvers are given. */
function headers(h: Record<string, string>): (name: string) => string | undefined {
  return (name) => h[name.toLowerCase()];
}

describe("tokenFrom", () => {
  it("reads the session cookie", () => {
    expect(tokenFrom(headers({ cookie: `${COOKIE}=abc123` }), COOKIE)).toBe("abc123");
  });

  it("finds it among other cookies, with or without spacing", () => {
    expect(
      tokenFrom(headers({ cookie: `theme=dark; ${COOKIE}=abc123; other=1` }), COOKIE),
    ).toBe("abc123");
    expect(tokenFrom(headers({ cookie: `a=1;${COOKIE}=abc123` }), COOKIE)).toBe("abc123");
  });

  it("does not match a cookie whose name merely ends with ours", () => {
    expect(tokenFrom(headers({ cookie: `not_bib_session=stolen` }), COOKIE)).toBeNull();
  });

  it("url-decodes the value", () => {
    expect(tokenFrom(headers({ cookie: `${COOKIE}=a%2Bb` }), COOKIE)).toBe("a+b");
  });

  it("accepts Authorization: Bearer for non-browser callers, case-insensitively", () => {
    expect(tokenFrom(headers({ authorization: "Bearer abc123" }), COOKIE)).toBe("abc123");
    expect(tokenFrom(headers({ authorization: "bearer abc123" }), COOKIE)).toBe("abc123");
  });

  it("prefers an explicit Authorization header over the ambient cookie", () => {
    const got = tokenFrom(
      headers({ authorization: "Bearer explicit", cookie: `${COOKIE}=ambient` }),
      COOKIE,
    );
    expect(got).toBe("explicit");
  });

  it("ignores a non-bearer or empty authorization scheme", () => {
    expect(tokenFrom(headers({ authorization: "Basic abc123" }), COOKIE)).toBeNull();
    expect(tokenFrom(headers({ authorization: "Bearer" }), COOKIE)).toBeNull();
    expect(tokenFrom(headers({ authorization: "Bearer " }), COOKIE)).toBeNull();
  });

  it("is null when there is nothing to read", () => {
    expect(tokenFrom(headers({}), COOKIE)).toBeNull();
    expect(tokenFrom(headers({ cookie: "theme=dark" }), COOKIE)).toBeNull();
  });
});

describe("devHeaderResolver", () => {
  const resolve = devHeaderResolver();

  it("accepts x-user-id and yields a tenant-less principal", async () => {
    const principal = await resolve(headers({ "x-user-id": "u-1" }));
    // No tenant: even the dev path cannot skip the org switch, so nothing that
    // needs a tenant works differently under it.
    expect(principal).toEqual({
      userId: "u-1",
      sessionId: "00000000-0000-0000-0000-0000000000de",
      tenantId: null,
      audience: null,
      role: null,
      commercialVisibility: null,
    });
  });

  it("is null with no header or an empty one", async () => {
    expect(await resolve(headers({}))).toBeNull();
    expect(await resolve(headers({ "x-user-id": "" }))).toBeNull();
  });
});

describe("firstOf", () => {
  const never: PrincipalResolver = () => Promise.resolve(null);
  const always = (userId: string): PrincipalResolver => () =>
    Promise.resolve({
      userId,
      sessionId: "s",
      tenantId: null,
      audience: null,
      role: null,
      commercialVisibility: null,
    });

  it("returns the first resolver that answers", async () => {
    const principal = await firstOf(never, always("second"), always("third"))(headers({}));
    expect(principal?.userId).toBe("second");
  });

  it("is null when none answer", async () => {
    expect(await firstOf(never, never)(headers({}))).toBeNull();
  });
});
