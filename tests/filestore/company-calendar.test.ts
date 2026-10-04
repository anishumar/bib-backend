// A draft is drawn on its COMPANY's day (0337), as Send or Issue will date it:
// a New York company's draft drawn at 20:30 UTC on 28 September is dated the
// 28th, though the firm in Delhi is already on the 29th.
import { describe, expect, it } from "vitest";
import { FileStoreService } from "../../src/usecase/filestore/service";
import {
  FakeBlobStore,
  FakeContentDigest,
  FakeDocumentStoreRepo,
  FakeRenderSource,
  FakeRenderer,
  aRenderableDocument,
} from "../../src/testfakes/filestore";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { CopyAlreadyMade } from "../../src/domain/render/errors";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const SUBJECT = "44444444-4444-4444-4444-444444444444";
const NEW_YORK_CO = "55555555-5555-5555-5555-555555555555";
const actor = { type: "human" as const, id: USER };

function makeService() {
  const documents = new FakeDocumentStoreRepo();
  const renderSource = new FakeRenderSource();
  renderSource.renderable = ["engagement_letter", "invoice", "proposal"];
  renderSource.issuers.set(SUBJECT, NEW_YORK_CO);
  const timeZones = new FakeFirmTimeZone("Asia/Kolkata");
  timeZones.setCompany(NEW_YORK_CO, { timeZone: "America/New_York" });
  // 20:30 UTC on 28 September: 02:00 on the 29th in Delhi, 16:30 on the 28th in New York.
  const clock = new FakeClock(new Date("2026-09-28T20:30:00Z"));
  const service = new FileStoreService({
    documents,
    blobs: new FakeBlobStore(),
    digest: new FakeContentDigest(),
    ids: new FakeIds(),
    events: new RecordingEventSink(),
    maxUploadBytes: 1024 * 1024,
    renderer: new FakeRenderer(),
    renderSource,
    timeZones,
    clock,
  });
  return { service, documents, renderSource, timeZones };
}

describe("a draft is drawn on its company's day (0337)", () => {
  it("files a draft invoice's copy dated on its company's day", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(SUBJECT, aRenderableDocument("INV-1"));
    renderSource.drafts.add(SUBJECT);
    await service.render({ tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: SUBJECT, actor });
    expect(renderSource.asked).toEqual(["2026-09-28"]);
  });

  it("previews a proposal and an invoice on their company's day", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(SUBJECT, aRenderableDocument("PR-1"));
    await service.preview({ tenantId: TENANT, kind: "proposal", subjectRef: SUBJECT });
    await service.preview({ tenantId: TENANT, kind: "invoice", subjectRef: SUBJECT });
    expect(renderSource.asked).toEqual(["2026-09-28", "2026-09-28"]);
  });

  it("holds a letter's asOf to its company's day or one either side", async () => {
    const { service, renderSource } = makeService();
    renderSource.documents.set(SUBJECT, aRenderableDocument());
    // The 27th is one day before New York's 28th, but two before Delhi's 29th.
    await service.preview({ tenantId: TENANT, kind: "engagement_letter", subjectRef: SUBJECT, asOf: "2026-09-27" });
    expect(renderSource.asked).toEqual(["2026-09-27"]);
    await expect(
      service.preview({ tenantId: TENANT, kind: "engagement_letter", subjectRef: SUBJECT, asOf: "2026-09-30" }),
    ).rejects.toThrow(/cannot be today where you are/);
  });

  it("keeps a company on the firm's clock on the firm's day", async () => {
    const { service, renderSource, timeZones } = makeService();
    timeZones.setCompany(NEW_YORK_CO, { timeZone: null });
    renderSource.documents.set(SUBJECT, aRenderableDocument("PR-1"));
    await service.preview({ tenantId: TENANT, kind: "proposal", subjectRef: SUBJECT });
    expect(renderSource.asked).toEqual(["2026-09-29"]);
  });

  it("says the day the copy of record was made on its company's calendar", async () => {
    const { service, renderSource, documents } = makeService();
    renderSource.documents.set(SUBJECT, aRenderableDocument("INV/2026-27/0004"));
    await service.render({ tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: SUBJECT, actor });
    const [made] = documents.documents;
    if (made === undefined) throw new Error("no copy filed");
    documents.documents[0] = { ...made, createdAt: "2026-09-28T20:30:00.000Z" };
    const second = service.render({
      tenantId: TENANT, kind: "invoice", subjectKind: "invoice", subjectRef: SUBJECT, actor,
    });
    await expect(second).rejects.toBeInstanceOf(CopyAlreadyMade);
    await expect(second).rejects.toThrow(/made on 28 Sep/);
  });
});
