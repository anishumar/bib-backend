// The service catalogue's body (G2.1 / G2.2 / G2.3) — the TEN fields the old
// services master carried and the first pass dropped. Ten, not the eleven
// 9ca823f's subject claims: see the count argued on `ServiceBody`.
//
// Three things are being proven here, and they are the reasons the fields were
// worth restoring rather than the fields themselves:
//
//   1. Every one of them is OPTIONAL, so the service versions already published
//      and frozen still validate and still read. A required field would strand
//      them: a published body cannot be edited to carry it, and there is no
//      honest value to invent for a document that never said it.
//   2. The rejection messages name the field, the bad value and the valid set —
//      CLAUDE.md's rule, and it earns its keep most on `module`, where the
//      difference between "frc" and "FRC" is a revenue report silently split in
//      two rather than an error anybody sees.
//   3. Absence reads back as null and NEVER as a default. `recurrence` absent is
//      not `one_time` and `slaDays` absent is not 0 — one would put a billing
//      frequency nobody chose on an engagement letter, the other would invent a
//      breach out of silence.
//
// The database half of G2.1's acceptance — that revenue actually groups by Dept
// in SQL, over bodies stored verbatim — is in catalogue.integration.test.ts,
// because a `GROUP BY body->>'module'` is a claim only Postgres can settle.
import { describe, expect, it } from "vitest";
import { ConfigService } from "../../src/usecase/config/service";
import { makeConfigFakes } from "../../src/testfakes/config";
import { InvalidBody, InvalidKey } from "../../src/domain/config/errors";
import {
  MAX_REPORTING_AXIS_LENGTH,
  MAX_SERVICE_REF_LENGTH,
  MAX_SLA_DAYS,
  SERVICE_RECURRENCES,
  isValidKey,
  readServiceBody,
} from "../../src/domain/config/model";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-0000000000b1" };

/** The six fields the catalogue shipped with. Everything G2.1–G2.3 adds is laid
 *  on top of this, which is also what makes it the fixture for "a body written
 *  before these fields existed". */
const ORIGINAL = {
  name: "GST monthly filing",
  description: "GSTR-1 and GSTR-3B for one registration",
  category: "indirect-tax",
  jurisdictions: ["IN"],
  billingBasis: "fixed" as const,
};

function service(): ConfigService {
  return new ConfigService(makeConfigFakes());
}

/** Define a service with this body and hand back the failure, so a test can
 *  assert on the SENTENCE rather than only on the type. */
async function reject(
  body: Record<string, unknown>,
  key = "gst-filing",
): Promise<Error> {
  const err = await service()
    .define({ tenantId: TENANT, kind: "service", key, body }, ACTOR)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidBody);
  return err as Error;
}

async function accept(body: Record<string, unknown>, key = "gst-filing"): Promise<void> {
  await expect(
    service().define({ tenantId: TENANT, kind: "service", key, body }, ACTOR),
  ).resolves.toBeDefined();
}

describe("G2.1 — ref, the firm's own service code", () => {
  it("carries the code as the firm writes it, upper case and all", async () => {
    await accept({ ...ORIGINAL, ref: "A1" });
  });

  it("is the reason ref is not the entry key", async () => {
    // The decision, as a test rather than only as a comment: the key is a
    // lowercase url-safe handle by rule and the firm's code is "A1", so putting
    // the code on the key would mean storing "a1" and upper-casing it to print
    // — a rendering lie on a document that is supposed to cite the firm's own
    // code. The body holds what the firm writes; the key stays the pin target.
    expect(isValidKey("A1")).toBe(false);
    await expect(
      service().define(
        { tenantId: TENANT, kind: "service", key: "A1", body: ORIGINAL },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(InvalidKey);
    await accept({ ...ORIGINAL, ref: "A1" });
  });

  it("is optional — a service the firm's master has no code for still publishes", async () => {
    await accept({ ...ORIGINAL, ref: null });
    await accept(ORIGINAL, "advisory");
  });

  it("refuses a code with surrounding whitespace, because it is joined on", async () => {
    const err = await reject({ ...ORIGINAL, ref: " A1" });
    expect(err.message).toContain('"ref"');
    expect(err.message).toContain('" A1"');
    expect(err.message).toContain("A1");
  });

  it("refuses an empty code rather than printing a blank where a code goes", async () => {
    expect((await reject({ ...ORIGINAL, ref: "" })).message).toContain('"ref"');
  });

  it("refuses a description pasted into the code field", async () => {
    const err = await reject({ ...ORIGINAL, ref: "A".repeat(MAX_SERVICE_REF_LENGTH + 1) });
    expect(err.message).toContain(String(MAX_SERVICE_REF_LENGTH));
  });
});

describe("G2.1 — module and group, two independent axes", () => {
  it("files a service under a Dept and a delivery team", async () => {
    await accept({ ...ORIGINAL, module: "FRC", group: "FINCOMPLIANCE" });
  });

  it("accepts a delivery team whose name has a space in it", async () => {
    // "VCFO CONSOLE" is one of the firm's real teams. A pattern that refused it
    // would push the firm into inventing a second spelling of its own org chart.
    await accept({ ...ORIGINAL, module: "FRC", group: "VCFO CONSOLE" });
  });

  it("lets one group sit under two different modules", async () => {
    // The whole reason group is not nested under module: FINCOMPLIANCE delivers
    // under both FRC and TRC. A hierarchy would make one of these two rows
    // impossible and force a duplicate catalogue entry per Dept — a second row
    // to keep in step, and revenue counted twice.
    await accept({ ...ORIGINAL, module: "FRC", group: "FINCOMPLIANCE" }, "gst-filing");
    await accept({ ...ORIGINAL, module: "TRC", group: "FINCOMPLIANCE" }, "tds-filing");
  });

  it("refuses a lower-case Dept, and says why the case matters", async () => {
    // The failure this prevents is not a crash. "frc" beside "FRC" groups as two
    // departments in `GROUP BY body->>'module'`, and the dashboard shows two
    // half-sized Depts that both look plausible.
    const err = await reject({ ...ORIGINAL, module: "frc" });
    expect(err.message).toContain('"module"');
    expect(err.message).toContain('"frc"');
    expect(err.message).toContain("FRC");
    expect(err.message).toContain("TRC");
    expect(err.message).toContain("RAA");
  });

  it("refuses a Dept with trailing whitespace", async () => {
    expect((await reject({ ...ORIGINAL, module: "FRC " })).message).toContain('"FRC "');
  });

  it("names the delivery team's own examples when group is the bad one", async () => {
    const err = await reject({ ...ORIGINAL, group: "fincompliance" });
    expect(err.message).toContain('"group"');
    expect(err.message).toContain("FINCOMPLIANCE");
    expect(err.message).toContain(String(MAX_REPORTING_AXIS_LENGTH));
  });

  it("does not cross-validate the two", async () => {
    // Independent dimensions: a group with no module, and a module with no
    // group, are both ordinary states of a real catalogue mid-migration.
    await accept({ ...ORIGINAL, module: "RAA" });
    await accept({ ...ORIGINAL, group: "PAYROLL" }, "payroll-run");
  });
});

describe("G2.2 — the four scope blocks", () => {
  const BLOCKS = {
    scope: "Preparation and filing of GSTR-1 and GSTR-3B for one GSTIN.",
    clientObligations: "Books and bank statements shared by the 5th of each month.",
    volumeLimits: "Under 1,000 entries per month; under 8 bank accounts.",
    exclusions: "Departmental representation, appeals and litigation support.",
  };

  it("stores the firm's own words, verbatim", async () => {
    // Verbatim is the point. These four blocks are what an engagement letter is
    // assembled from and what protects the firm in a dispute, so the catalogue
    // has to hand back the sentence the firm wrote — not a re-rendering of it.
    const { draft } = await service().define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: { ...ORIGINAL, ...BLOCKS } },
      ACTOR,
    );
    expect(draft.body["volumeLimits"]).toBe("Under 1,000 entries per month; under 8 bank accounts.");
    expect(readServiceBody(draft.body).exclusions).toBe(BLOCKS.exclusions);
  });

  it("is optional on every block — the existing catalogue keeps validating", async () => {
    await accept(ORIGINAL);
    await accept({ ...ORIGINAL, scope: null, clientObligations: null, volumeLimits: null, exclusions: null });
  });

  it.each(["scope", "clientObligations", "volumeLimits", "exclusions"])(
    "refuses an empty %s instead of printing a heading with nothing under it",
    async (field) => {
      const err = await reject({ ...ORIGINAL, [field]: "   " });
      expect(err.message).toContain(`"${field}"`);
      expect(err.message).toContain("null");
    },
  );

  it("refuses a limit parsed into a typed object, and says why prose is the point", async () => {
    // Nothing here is metered. A typed { maxEntries: 1000 } would model an
    // enforcement mechanism that does not exist — when a client goes past a
    // ceiling the firm re-assesses the engagement, it does not auto-charge.
    const err = await reject({ ...ORIGINAL, volumeLimits: { maxEntries: 1000 } });
    expect(err.message).toContain('"volumeLimits"');
    expect(err.message).toContain("metered");
  });
});

describe("G2.3 — slaDays", () => {
  it("carries the turnaround a work item will snapshot", async () => {
    const { draft } = await service().define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: { ...ORIGINAL, slaDays: 30 } },
      ACTOR,
    );
    // What T3.1 reads, off the PINNED version, at the moment the work item is
    // created — so a catalogue revision next quarter cannot make finished work
    // retroactively late.
    expect(readServiceBody(draft.body).slaDays).toBe(30);
  });

  it("allows zero — due on the day the letter is signed", async () => {
    await accept({ ...ORIGINAL, slaDays: 0 });
  });

  it("refuses a day count given as a string, unlike money", async () => {
    const err = await reject({ ...ORIGINAL, slaDays: "30" });
    expect(err.message).toContain('"slaDays"');
    expect(err.message).toContain('"30"');
    expect(err.message).toContain("NUMBER");
  });

  it.each([30.5, -1, Number.NaN])("refuses %p", async (value) => {
    expect((await reject({ ...ORIGINAL, slaDays: value })).message).toContain('"slaDays"');
  });

  it("refuses a date typed into a day count", async () => {
    // The realistic fat finger: 20260315 pasted into an SLA column. Without the
    // cap it stores happily and the work item is due in the year 57000, which
    // looks exactly like a feature working.
    const err = await reject({ ...ORIGINAL, slaDays: 20260315 });
    expect(err.message).toContain(String(MAX_SLA_DAYS));
  });

  it("is optional, and null is not zero", async () => {
    await accept({ ...ORIGINAL, slaDays: null });
    expect(readServiceBody({ ...ORIGINAL, slaDays: null }).slaDays).toBeNull();
    // The distinction the field turns on: nobody committed to anything, so a
    // consumer must not compute a due date at all — 0 would invent a breach on
    // the day of signing.
    expect(readServiceBody(ORIGINAL).slaDays).not.toBe(0);
  });
});

describe("G2.3 — recurrence is not billingBasis", () => {
  it.each(SERVICE_RECURRENCES)("accepts %s", async (recurrence) => {
    await accept({ ...ORIGINAL, recurrence });
  });

  it("lets a service recur monthly while being priced as a retainer", async () => {
    // The two axes are independent: how often the work comes round, and what the
    // price is a price OF. The engagement letter's billing_frequency (G1.6)
    // defaults from recurrence and is then the letter's own commercial term, so
    // billing a monthly service quarterly is a decision the document records —
    // not a shape the catalogue has to forbid.
    const { draft } = await service().define(
      {
        tenantId: TENANT,
        kind: "service",
        key: "vcfo",
        body: { ...ORIGINAL, name: "vCFO", billingBasis: "retainer", recurrence: "monthly" },
      },
      ACTOR,
    );
    const stored = readServiceBody(draft.body);
    expect(stored.recurrence).toBe("monthly");
    expect(stored.billingBasis).toBe("retainer");
  });

  it("refuses a period that is not one of the five, without confusing it for a basis", async () => {
    const err = await reject({ ...ORIGINAL, recurrence: "month" });
    expect(err.message).toContain('"recurrence"');
    expect(err.message).toContain('"month"');
    expect(err.message).toContain("monthly");
    expect(err.message).toContain("billingBasis");
  });

  it("refuses a billing basis smuggled into recurrence", async () => {
    expect((await reject({ ...ORIGINAL, recurrence: "fixed" })).message).toContain("one_time");
  });
});

describe("G2.3 — pricingNote", () => {
  it("gives listPrice: null a reason", async () => {
    await accept({
      ...ORIGINAL,
      billingBasis: "hourly",
      listPrice: null,
      pricingNote: "As mutually agreed",
    });
  });

  it("is allowed beside a price too", async () => {
    // "Plus statutory fees at actuals" belongs next to the money on a document.
    // Conditioning the note on listPrice being null would push that sentence
    // into `description`, where nothing prints it beside the amount.
    await accept({
      ...ORIGINAL,
      listPrice: { amount: "25000.00", currency: "INR" },
      pricingNote: "Plus statutory fees and GST at actuals",
    });
  });

  it("refuses an empty note, which says no more than the null price did", async () => {
    const err = await reject({ ...ORIGINAL, listPrice: null, pricingNote: "" });
    expect(err.message).toContain('"pricingNote"');
    expect(err.message).toContain("As mutually agreed");
  });
});

describe("the unknown-field wall covers the new fields too", () => {
  it("refuses a misspelt slaDays and offers the real one", async () => {
    // Every field added to the body has to be added to SERVICE_FIELDS as well,
    // or a body carrying it is refused; the mirror failure is a near-miss
    // spelling that would save and do nothing. This is the test that fails when
    // somebody adds one and forgets the other.
    const err = await reject({ ...ORIGINAL, slaDay: 30 });
    expect(err.message).toContain('"slaDay"');
    expect(err.message).toContain("slaDays");
  });

  it("lists every field a catalogue row may carry", async () => {
    const err = await reject({ ...ORIGINAL, nonsense: true });
    for (const field of [
      "ref",
      "module",
      "group",
      "recurrence",
      "slaDays",
      "pricingNote",
      "scope",
      "clientObligations",
      "volumeLimits",
      "exclusions",
    ]) {
      expect(err.message).toContain(field);
    }
  });
});

describe("reading a stored body back", () => {
  it("reads every field off a full catalogue row", () => {
    const stored = readServiceBody({
      name: "GST monthly filing",
      ref: "A1",
      description: "GSTR-1 and GSTR-3B",
      category: "indirect-tax",
      module: "FRC",
      group: "FINCOMPLIANCE",
      jurisdictions: ["IN"],
      billingBasis: "fixed",
      recurrence: "monthly",
      slaDays: 7,
      listPrice: { amount: "25000.00", currency: "inr" },
      pricingNote: "Plus statutory fees at actuals",
      scope: "Filing of GSTR-1 and GSTR-3B.",
      clientObligations: "Books by the 5th.",
      volumeLimits: "Under 1,000 entries.",
      exclusions: "Appeals and litigation.",
      workflowTemplateKey: "gst-monthly-process",
    });
    expect(stored).toEqual({
      name: "GST monthly filing",
      ref: "A1",
      description: "GSTR-1 and GSTR-3B",
      category: "indirect-tax",
      module: "FRC",
      group: "FINCOMPLIANCE",
      jurisdictions: ["IN"],
      billingBasis: "fixed",
      recurrence: "monthly",
      slaDays: 7,
      // The currency is normalised on the way out because it is compared and
      // grouped; the amount is handed back exactly as stored, because "1499.5"
      // and "1499.50" are the same number to the numeric that adds them up.
      listPrice: { amount: "25000.00", currency: "INR" },
      pricingNote: "Plus statutory fees at actuals",
      scope: "Filing of GSTR-1 and GSTR-3B.",
      clientObligations: "Books by the 5th.",
      volumeLimits: "Under 1,000 entries.",
      exclusions: "Appeals and litigation.",
      // How the service is DELIVERED (T2.7). A key, not a version id: the
      // catalogue points at the firm's current process and the JOB is what pins
      // the version it started on.
      workflowTemplateKey: "gst-monthly-process",
      // How it is taxed (Q056): not stated in this body.
      tax: {},
    });
  });

  it("reads a version published before any of these fields existed", () => {
    // The requirement that made every new field optional: this body is frozen
    // and can never be edited to carry them. It has to keep resolving, and every
    // missing field has to read as "not stated" rather than as a default.
    const stored = readServiceBody(ORIGINAL);
    expect(stored.ref).toBeNull();
    expect(stored.module).toBeNull();
    expect(stored.group).toBeNull();
    expect(stored.recurrence).toBeNull();
    expect(stored.slaDays).toBeNull();
    expect(stored.pricingNote).toBeNull();
    expect(stored.scope).toBeNull();
    expect(stored.clientObligations).toBeNull();
    expect(stored.volumeLimits).toBeNull();
    expect(stored.exclusions).toBeNull();
    expect(stored.name).toBe("GST monthly filing");
    expect(stored.billingBasis).toBe("fixed");
  });

  it("never invents a billing basis for a body that has none", () => {
    // A hand-edited row. `fixed` would be a price basis on a document that the
    // firm never chose, which is worse than an empty cell somebody notices.
    expect(readServiceBody({ name: "Hand edited" }).billingBasis).toBeNull();
  });

  it("collapses blank text to null, so no consumer has to test for both", () => {
    expect(readServiceBody({ ...ORIGINAL, scope: "   " }).scope).toBeNull();
    expect(readServiceBody({ ...ORIGINAL, ref: "" }).ref).toBeNull();
  });

  it("reads a half-stated or malformed price as no list price at all", () => {
    // A frozen row cannot be edited to fix itself, so the read has to answer
    // something. "We quote it" is the only honest answer available.
    expect(readServiceBody({ ...ORIGINAL, listPrice: { amount: "25000" } }).listPrice).toBeNull();
    expect(readServiceBody({ ...ORIGINAL, listPrice: 25000 }).listPrice).toBeNull();
    expect(readServiceBody({ ...ORIGINAL, listPrice: null }).listPrice).toBeNull();
  });

  it("falls back rather than throwing on a body that is barely a body", () => {
    const stored = readServiceBody({});
    expect(stored.name).toBe("");
    expect(stored.jurisdictions).toEqual([]);
    expect(stored.slaDays).toBeNull();
  });
});
