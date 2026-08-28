// THE HONEST REGISTRY, enforced and now tested.
//
// This codebase registers exactly three stubs — the dev auth resolver, the
// logging mailer, and the attested e-sign signer — and CLAUDE.md's rule is that
// none of them may reach a public environment. Each has a boot gate in
// validate.ts; until now none of those gates had a test, so all three could
// have been deleted or inverted and the build would have stayed green.
//
// That is worth guarding precisely because the failure is silent: a gate that
// stops refusing does not break anything, it just quietly permits the thing it
// was written to forbid.
import { describe, expect, it } from "vitest";
import { validateServer } from "../../src/config/validate";
import type { Config } from "../../src/config/config";

/**
 * A production-like config that passes every check.
 *
 * Built here rather than loaded, because the point is to move ONE field at a
 * time and see the boot refuse. Anything that is not the subject of a test is
 * deliberately safe.
 */
function productionLike(overrides: Partial<Config["auth"]> = {}): Config {
  return {
    environment: "production",
    logLevel: "info",
    port: 8080,
    docsEnabled: false,
    db: {
      ownerUrl: "postgres://owner:secret@db.internal:5432/bib",
      appUrl: "postgres://app:secret@db.internal:5432/bib",
      appPassword: "secret",
      ownerPassword: "secret",
      poolApp: 10,
      poolOwner: 2,
    },
    auth: {
      sessionCookieName: "bib_session",
      sessionCookieSecure: true,
      appBaseUrl: "https://app.example.com",
      devAuthEnabled: false,
      mailTransport: "smtp" as unknown as "log",
      esignProvider: "docusign" as unknown as "attested",
      internalClients: [
        { name: "onboarding", key: "a-real-and-long-provisioning-key", capabilities: ["tenant.provision"] },
      ],
      ...overrides,
    },
    cors: { origins: ["https://app.example.com"] },
    rateLimit: { trustProxy: true, authPerMinute: 10, generalPerMinute: 300 },
  } as unknown as Config;
}

describe("a production-like environment refuses every stub", () => {
  it("boots when nothing is stubbed", () => {
    // The control. Without it, a test asserting "it throws" proves nothing —
    // it might be throwing for a reason nobody intended.
    expect(() => {
      validateServer(productionLike());
    }).not.toThrow();
  });

  it("refuses the dev auth resolver — an x-user-id header is not authentication", () => {
    expect(() => {
      validateServer(productionLike({ devAuthEnabled: true }));
    }).toThrow(/BIB_DEV_AUTH_ENABLED/);
  });

  it("refuses the logging mailer — sign-in links would land in log aggregation", () => {
    expect(() => {
      validateServer(productionLike({ mailTransport: "log" }));
    }).toThrow(/BIB_MAIL_TRANSPORT/);
  });

  it("refuses the attested signer — an engagement letter creates obligations", () => {
    // The third stub, and the newest. It records that somebody at the firm SAYS
    // the client signed; it cannot prove it.
    expect(() => {
      validateServer(productionLike({ esignProvider: "attested" }));
    }).toThrow(/BIB_ESIGN_PROVIDER/);
  });

  it("names the fix in every refusal, not just the fault", () => {
    // A boot crash is read by somebody at a bad moment. Each of these has to
    // say which variable to change.
    const refusals = [
      productionLike({ devAuthEnabled: true }),
      productionLike({ mailTransport: "log" }),
      productionLike({ esignProvider: "attested" }),
    ].map((cfg) => {
      try {
        validateServer(cfg);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    });
    for (const message of refusals) {
      expect(message).toMatch(/^BIB_[A-Z_]+/);
      expect(message).toContain("production-like");
    }
  });
});

describe("a development environment allows them", () => {
  it("boots with all three, because that is what local development is", () => {
    const dev = { ...productionLike(), environment: "development" } as unknown as Config;
    const stubbed = {
      ...dev,
      auth: {
        ...dev.auth,
        devAuthEnabled: true,
        mailTransport: "log",
        esignProvider: "attested",
      },
    } as unknown as Config;
    expect(() => {
      validateServer(stubbed);
    }).not.toThrow();
  });
});
