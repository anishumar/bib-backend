// The draft UAE, Singapore and US packs (Q074): every row sourced and well
// formed, and OFF: loaded only on request, unconfirmed, on no service, so a
// sweep puts nothing on any calendar.
import { describe, expect, it } from "vitest";
import { INTL_RULE_PACKS } from "../../src/domain/obligation/rulepack-intl";
import { ObligationService } from "../../src/usecase/obligation/service";
import {
  FakeCalendarSource,
  FakeCompliancePolicySource,
  FakeObligationExceptionRepo,
  FakeObligationInstanceRepo,
  FakeObligationServices,
  FakeObligationStateRepo,
  FakeObligationTemplateRepo,
  FakeObligationTenants,
  FakeResolutionOptionRepo,
  FakeRuleServiceLinks,
  FakeWorkItemRaiser,
} from "../../src/testfakes/obligation";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";

const FIRM = "00000000-0000-4000-8000-0000000000f1";
const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-000000000001" };

describe("the draft country packs", () => {
  it("cover the UAE, Singapore and the US, each row with a source and one honest due date shape", () => {
    expect(INTL_RULE_PACKS.map((p) => p.jurisdiction)).toEqual(["AE", "SG", "US"]);
    for (const pack of INTL_RULE_PACKS) {
      for (const r of pack.rules) {
        expect(r.source).toMatch(/^https:\/\//);
        expect((r.dueRule === null) !== (r.unresolvedReason === null)).toBe(true);
        if (r.periodBasis === "authority_assigned") expect(r.module).not.toBe("");
      }
    }
  });

  it("load unconfirmed, on no service, idempotently, and generate nothing", async () => {
    const templates = new FakeObligationTemplateRepo();
    const instances = new FakeObligationInstanceRepo();
    const links = new FakeRuleServiceLinks();
    const calendarSource = new FakeCalendarSource();
    const states = new FakeObligationStateRepo();
    templates.links = links;
    templates.instances = instances;
    instances.templates = templates;
    instances.links = links;
    calendarSource.links = links;
    links.templates = templates;
    links.instances = instances;
    links.calendar = calendarSource;
    const service = new ObligationService({
      timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
      templates, exceptions: new FakeObligationExceptionRepo(), states,
      resolutionOptions: new FakeResolutionOptionRepo(), instances, links,
      compliancePolicy: new FakeCompliancePolicySource(), calendarSource,
      services: new FakeObligationServices(), workItems: new FakeWorkItemRaiser(),
      tenants: new FakeObligationTenants(), ids: new FakeIds(),
      clock: { now: () => new Date("2026-10-05T06:00:00Z") }, events: new RecordingEventSink(),
    });
    await service.seedDefaultStates(FIRM, ACTOR);
    const ae = INTL_RULE_PACKS.find((p) => p.jurisdiction === "AE");
    expect(await service.seedCountryRulePack(FIRM, "AE", ACTOR)).toBe(ae?.rules.length);
    expect(await service.seedCountryRulePack(FIRM, "AE", ACTOR)).toBe(0);
    expect(templates.rows.every((t) => t.status === "unconfirmed" && t.jurisdiction === "AE")).toBe(true);
    calendarSource.subjects.push({
      entityPartyId: "00000000-0000-4000-8000-0000000000e1", engagementId: "00000000-0000-4000-8000-00000000e001",
      effectiveFrom: "2026-01-01", jurisdiction: "AE", entityType: null, serviceEntryId: "00000000-0000-4000-8000-00000000c001",
      financialYearEnd: "12-31", returnPeriods: [{ tax: "VAT", frequency: "quarterly", firstMonth: 2 }],
    });
    const r = await service.generate(FIRM, { from: "2026-07-01", to: "2027-10-05" }, ACTOR);
    expect(r.created).toBe(0);
    // On no service: the chain has no live link at all.
    expect(templates.rows.every((t) => !links.isLive(FIRM, t.lineageId, "00000000-0000-4000-8000-00000000c001"))).toBe(true);
  });
});
