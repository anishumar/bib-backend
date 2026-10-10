// FinCompliance intake (docs/FIN_BUILD_PLAN.md F2.1, F2.2): which files fin
// takes, which reader each goes to, and what the sweep may and may not do.
//
// The unique constraint, RLS and the switch's cut are database properties and
// are proven against real Postgres in `tests/fin/intake.integration.test.ts`.
import { describe, expect, it } from "vitest";
import { DOCUMENT_KINDS } from "../../src/domain/filestore/model";
import type { DocumentKind } from "../../src/domain/filestore/model";
import { routeFor, takenKinds, takesDocument } from "../../src/domain/fin/intake";
import { FinNotEnabled } from "../../src/domain/fin/errors";
import { FinIntakeService } from "../../src/usecase/fin/intake";
import { FakeFinFirms, FakeFinIntakeStore } from "../../src/testfakes/fin";
import type { StoredFile } from "../../src/testfakes/fin";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";

const FIRM = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";

describe("which reader a file goes to", () => {
  it.each([
    ["application/pdf", "INV-25-1001.pdf", "pdf", "media_type"],
    ["Application/PDF; charset=binary", "x.pdf", "pdf", "media_type"],
    ["text/csv", "Statement October 2025.csv", "sheet", "media_type"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Payroll_Aug2025.xlsx", "sheet", "media_type"],
    ["application/vnd.ms-excel", "SALARY Sep 25.xls", "sheet", "media_type"],
    ["image/jpeg", "WhatsApp Image 2025-10-07 at 14.41.43.jpeg", "image", "media_type"],
    ["image/heic", "IMG_0001.HEIC", "image", "media_type"],
    ["application/zip", "October.zip", "archive", "media_type"],
  ] as const)("%s (%s) → %s by %s", (mediaType, filename, route, basis) => {
    expect(routeFor(mediaType, filename)).toEqual({ route, basis });
  });

  it("falls back to the extension when the declared type says nothing useful", () => {
    // What a phone or a browser often sends for a file it does not recognise.
    expect(routeFor("application/octet-stream", "IMG_20250217_174705.JPG")).toEqual({ route: "image", basis: "extension" });
    expect(routeFor("text/plain", "Statement March 2025.csv")).toEqual({ route: "sheet", basis: "extension" });
    expect(routeFor("", "scan1711_13.pdf")).toEqual({ route: "pdf", basis: "extension" });
  });

  it("sends anything it cannot place to a person, never away", () => {
    expect(routeFor("application/msword", "letter.doc")).toEqual({ route: "manual", basis: "none" });
    expect(routeFor("application/octet-stream", "no-extension")).toEqual({ route: "manual", basis: "none" });
    expect(routeFor("application/octet-stream", ".pdf")).toEqual({ route: "manual", basis: "none" });
    expect(routeFor("application/octet-stream", "trailing.")).toEqual({ route: "manual", basis: "none" });
  });
});

describe("which files fin takes", () => {
  it("takes only what a person supplied", () => {
    expect(takesDocument("other", "uploaded")).toBe(true);
    expect(takesDocument("other", "generated")).toBe(false);
  });

  it("leaves out KYC, the firm's own brand, and every kind behind the fee wall", () => {
    const left: DocumentKind[] = ["identity_proof", "brand_asset", "proposal", "engagement_letter", "invoice", "credit_note"];
    for (const kind of left) expect(takesDocument(kind, "uploaded"), kind).toBe(false);
    expect([...takenKinds(DOCUMENT_KINDS)].sort()).toEqual(
      ["correspondence", "other", "statutory_filing", "working_paper"].sort(),
    );
  });
});

let versionNo = 0;
function file(over: Partial<StoredFile> = {}): StoredFile {
  versionNo += 1;
  const hex = versionNo.toString(16).padStart(12, "0");
  return {
    tenantId: FIRM,
    documentId: `00000000-0000-4000-8000-1${hex.slice(1)}`,
    documentVersionId: `00000000-0000-4000-8000-${hex}`,
    clientPartyId: CLIENT,
    mediaType: "application/pdf",
    byteSize: 48_213,
    filename: "INV-25-1001.pdf",
    title: "Purchase invoice",
    kind: "other",
    origin: "uploaded",
    ...over,
  };
}

function svc(batchSize?: number) {
  const firms = new FakeFinFirms();
  firms.enabled.add(FIRM);
  const store = new FakeFinIntakeStore();
  const events = new RecordingEventSink();
  const service = new FinIntakeService({
    firms,
    candidates: store,
    items: store,
    events,
    ids: new FakeIds(),
    ...(batchSize === undefined ? {} : { batchSize }),
  });
  return { service, firms, store, events };
}

describe("the intake sweep", () => {
  it("takes each file in once, with its route, and says so in the ledger", async () => {
    const { service, store, events } = svc();
    store.files.push(file(), file({ mediaType: "text/csv", filename: "Statement.csv" }));

    const [report] = await service.sweep();
    expect(report).toMatchObject({ tenantId: FIRM, taken: 2, manual: 0, alreadyTaken: 0, more: false });
    expect(store.items.map((i) => i.route)).toEqual(["pdf", "sheet"]);
    expect(events.verbs()).toEqual(["fin.intake_routed", "fin.intake_routed"]);
    // The payload passed the ledger's own contract (no personal data): the
    // filename and the title never reach a log that cannot be erased.
    const payload = JSON.stringify(events.recorded.map((e) => e.payload));
    expect(payload).not.toContain("INV-25-1001");
    expect(payload).not.toContain("Purchase invoice");
  });

  it("takes nothing the second time, and writes no second event", async () => {
    const { service, store, events } = svc();
    store.files.push(file(), file());
    await service.sweep();
    const [again] = await service.sweep();
    expect(again).toMatchObject({ taken: 0, alreadyTaken: 0 });
    expect(store.items).toHaveLength(2);
    expect(events.verbs()).toHaveLength(2);
  });

  it("counts a file another run took first, and writes no event for it", async () => {
    const { service, store, events } = svc();
    const raced = file();
    store.files.push(raced, file());
    store.raced.add(raced.documentVersionId);
    const [report] = await service.sweep();
    expect(report).toMatchObject({ taken: 1, alreadyTaken: 1 });
    expect(events.verbs()).toHaveLength(1);
  });

  it("puts a file no reader fits on a person's desk, and counts it", async () => {
    const { service, store } = svc();
    store.files.push(file({ mediaType: "application/msword", filename: "notes.doc" }));
    const [report] = await service.sweep();
    expect(report).toMatchObject({ taken: 1, manual: 1 });
    expect(store.items[0]).toMatchObject({ route: "manual", routeBasis: "none" });
  });

  it("does not take what a person did not supply, or a kind it leaves out", async () => {
    const { service, store } = svc();
    store.files.push(file({ origin: "generated" }), file({ kind: "identity_proof" }), file({ kind: "invoice" }));
    const [report] = await service.sweep();
    expect(report).toMatchObject({ taken: 0 });
  });

  it("finishes a large batch over several runs, and says more is waiting", async () => {
    const { service, store } = svc(2);
    store.files.push(file(), file(), file());
    expect((await service.sweep())[0]).toMatchObject({ taken: 2, more: true });
    expect((await service.sweep())[0]).toMatchObject({ taken: 1, more: false });
  });

  it("does nothing for a firm that has not switched fin on", async () => {
    const { service, firms, store } = svc();
    firms.enabled.clear();
    store.files.push(file());
    expect(await service.sweep()).toEqual([]);
    expect(store.items).toHaveLength(0);
  });

  it("reports a firm it cannot read and carries on with the next", async () => {
    const { service, firms, store } = svc();
    firms.enabled.add(OTHER);
    store.broken.add(FIRM);
    store.files.push(file({ tenantId: OTHER }));
    const reports = await service.sweep();
    expect(reports.find((r) => r.tenantId === FIRM)?.failure).toContain("unreadable");
    expect(reports.find((r) => r.tenantId === OTHER)).toMatchObject({ taken: 1 });
  });
});

describe("reading the intake list", () => {
  it("answers a firm with fin on, newest first", async () => {
    const { service, store } = svc();
    store.files.push(file({ filename: "first.pdf" }), file({ filename: "second.pdf" }));
    await service.sweep();
    const items = await service.recent(FIRM, 10);
    expect(items.map((i) => i.filename)).toEqual(["second.pdf", "first.pdf"]);
  });

  it("refuses a firm with fin off as not there", async () => {
    const { service } = svc();
    await expect(service.recent(OTHER, 10)).rejects.toBeInstanceOf(FinNotEnabled);
  });
});
