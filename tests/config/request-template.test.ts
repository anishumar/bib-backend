// The registry's thirteenth kind (F1.1, migration 0384): what a firm asks a
// client for every period, and when. The validator's refusals, each with the
// sentence a partner reads; the one reader; `requestDates` against the
// calendar; and a template published and read back through the config service.
//
// The database half (the widened `entry_kind_check`, a real publish and pin) is
// request-template.integration.test.ts.
import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_ITEMS,
  REQUEST_ASK_KINDS,
  readRequestTemplate,
  requestDates,
  validateBody,
} from "../../src/domain/config/model";
import { ASK_KINDS } from "../../src/domain/clientask/model";
import { DOCUMENT_KINDS } from "../../src/domain/filestore/model";
import { ConfigService } from "../../src/usecase/config/service";
import { makeConfigFakes } from "../../src/testfakes/config";
import { InvalidBody } from "../../src/domain/config/errors";

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-0000000000c2" };

type Item = Record<string, unknown>;

/** One item of the firm's monthly close, overridable field by field. */
function item(over: Item = {}): Item {
  return {
    key: "purchases",
    label: "Purchase invoices for the month",
    askKind: "document",
    documentKind: "books_input",
    sendOffsetDays: 1,
    dueOffsetDays: 5,
    ...over,
  };
}

/** "Monthly close", the seed F1.7 will publish: four items, due on the 5th. */
function monthlyClose(): Record<string, unknown> {
  return {
    label: "Monthly close",
    items: [
      item({ key: "sales", label: "Sales invoices for the month" }),
      item({ key: "purchases" }),
      item({ key: "bank_statements", label: "Bank statements for every account" }),
      item({
        key: "no_cash_sales",
        label: "Confirm there were no cash sales this month",
        askKind: "approval",
        documentKind: null,
      }),
    ],
  };
}

const check = (body: Record<string, unknown>): string | null =>
  validateBody("request_template", body);

/** A template of exactly the items given, under a fixed label. */
const withItems = (...items: Item[]): Record<string, unknown> => ({ label: "Monthly close", items });

describe("a request template body", () => {
  it("accepts the firm's monthly close", () => {
    expect(check(monthlyClose())).toBeNull();
  });

  it("accepts every ask kind, with a document kind only on a document item", () => {
    expect(
      check(
        withItems(
          item({ key: "a1" }),
          item({ key: "q1", askKind: "question", documentKind: null }),
          item({ key: "p1", askKind: "approval", documentKind: null }),
        ),
      ),
    ).toBeNull();
  });

  it("accepts every document kind the upload can be filed as", () => {
    const items = DOCUMENT_KINDS.map((k, i) => item({ key: `d${String(i + 1)}`, documentKind: k }));
    expect(check(withItems(...items))).toBeNull();
  });

  it("accepts the bounds themselves: send 0 and 90, due 1 and 120, 30 items", () => {
    expect(check(withItems(item({ sendOffsetDays: 0, dueOffsetDays: 1 })))).toBeNull();
    expect(check(withItems(item({ sendOffsetDays: 90, dueOffsetDays: 120 })))).toBeNull();
    const thirty = Array.from({ length: MAX_REQUEST_ITEMS }, (_, i) => item({ key: `i${String(i + 1)}` }));
    expect(check(withItems(...thirty))).toBeNull();
  });

  it("accepts an item label of exactly 500 characters, measured after trimming", () => {
    expect(check(withItems(item({ label: `  ${"x".repeat(500)}  ` })))).toBeNull();
  });
});

describe("what a request template refuses, and the sentence it says", () => {
  it("refuses a duplicate item key, naming the item and the key", () => {
    const problem = check(withItems(item({ key: "bank" }), item({ key: "bank" })));
    expect(problem).toContain('items[1] ("bank")');
    expect(problem).toContain("appears twice");
  });

  it("refuses a key that is not a step-key handle", () => {
    for (const bad of ["Bank Statements", "b", "-bank", "bank-", 7, null]) {
      const problem = check(withItems(item({ key: bad })));
      expect(problem, String(bad)).toContain("items[0].key must be a lowercase handle");
    }
  });

  it("refuses a document item with no document kind, listing the kinds", () => {
    const leftOut = item({ key: "bank" });
    delete leftOut["documentKind"];
    for (const bad of [item({ key: "bank", documentKind: null }), leftOut, item({ key: "bank", documentKind: "receipt" })]) {
      const problem = check(withItems(bad));
      expect(problem, JSON.stringify(bad)).toContain('items[0] ("bank").documentKind must say what');
      expect(problem).toContain("books_input");
      expect(problem).toContain("working_paper");
    }
  });

  it("refuses a document kind on a question or an approval item", () => {
    for (const askKind of ["question", "approval"]) {
      const problem = check(withItems(item({ key: "cash", askKind, documentKind: "books_input" })));
      expect(problem).toContain(`items[0] ("cash").documentKind must be null for a ${askKind} item`);
      expect(problem).toContain('"books_input"');
    }
  });

  it("refuses a question item that leaves documentKind out: every field is stated", () => {
    const question = item({ askKind: "question" });
    delete question["documentKind"];
    const problem = check(withItems(question));
    expect(problem).toContain("documentKind must be null for a question item");
    expect(problem).toContain("Got nothing");
  });

  it("refuses an ask kind outside the three, naming the three", () => {
    const problem = check(withItems(item({ askKind: "upload" })));
    expect(problem).toContain("askKind must be one of document, question, approval");
    expect(problem).toContain('"upload"');
  });

  it("refuses a due day on or before the send day, saying what would do", () => {
    const equal = check(withItems(item({ sendOffsetDays: 5, dueOffsetDays: 5 })));
    expect(equal).toContain("dueOffsetDays is 5 and sendOffsetDays is 5");
    expect(equal).toContain("at least 6");
    const before = check(withItems(item({ sendOffsetDays: 7, dueOffsetDays: 3 })));
    expect(before).toContain("dueOffsetDays is 3 and sendOffsetDays is 7");
  });

  it("refuses a send offset outside 0 to 90, or not a whole number", () => {
    for (const bad of [-1, 91, 1.5, "1", null]) {
      const problem = check(withItems(item({ sendOffsetDays: bad })));
      expect(problem, String(bad)).toContain("sendOffsetDays must be a whole number of days from 0 to 90");
    }
  });

  it("refuses a due offset outside 1 to 120, or not a whole number", () => {
    for (const bad of [0, 121, 4.5, "5", null]) {
      const problem = check(withItems(item({ sendOffsetDays: 0, dueOffsetDays: bad })));
      expect(problem, String(bad)).toContain("dueOffsetDays must be a whole number of days from 1 to 120");
    }
  });

  it("refuses more than 30 items, and none at all", () => {
    const many = Array.from({ length: MAX_REQUEST_ITEMS + 1 }, (_, i) => item({ key: `i${String(i + 1)}` }));
    expect(check(withItems(...many))).toContain('"items" has 31 items, and one template holds at most 30');
    expect(check(withItems())).toContain('"items" must be a non-empty list');
    expect(check({ label: "Monthly close" })).toContain('"items" must be a non-empty list');
  });

  it("refuses an unknown field on the template and on an item, naming it and the valid set", () => {
    const top = check({ ...monthlyClose(), required: true });
    expect(top).toContain('unknown field "required"');
    expect(top).toContain("Valid: label, items");

    const onItem = check(withItems(item({ finHint: "bank" })));
    expect(onItem).toContain('items[0]: unknown field "finHint"');
    expect(onItem).toContain("Valid: key, label, askKind, documentKind, sendOffsetDays, dueOffsetDays");
  });

  it("refuses an item label that is blank or longer than 500 characters once trimmed", () => {
    expect(check(withItems(item({ label: "   " })))).toContain("label must be 1 to 500 characters");
    expect(check(withItems(item({ label: "x".repeat(501) })))).toContain("label must be 1 to 500 characters");
  });

  it("refuses a template label that is blank or longer than 200 characters", () => {
    expect(check({ ...monthlyClose(), label: " " })).toContain('"label" must be 1 to 200 characters');
    expect(check({ ...monthlyClose(), label: "x".repeat(201) })).toContain('"label" must be 1 to 200 characters');
  });

  it("refuses an item that is not an object", () => {
    expect(check(withItems("purchases" as unknown as Item))).toContain("items[0] must be { key, label");
  });
});

describe("reading a request template back", () => {
  it("reads every item in its order, labels trimmed", () => {
    const body = monthlyClose();
    (body["items"] as Item[])[0] = item({ key: "sales", label: "  Sales invoices  " });
    body["label"] = "  Monthly close ";
    const read = readRequestTemplate(body);
    expect(read?.label).toBe("Monthly close");
    expect(read?.items.map((i) => i.key)).toEqual(["sales", "purchases", "bank_statements", "no_cash_sales"]);
    expect(read?.items[0]).toEqual({
      key: "sales",
      label: "Sales invoices",
      askKind: "document",
      documentKind: "books_input",
      sendOffsetDays: 1,
      dueOffsetDays: 5,
    });
    expect(read?.items[3]?.documentKind).toBeNull();
    expect(read?.items[3]?.askKind).toBe("approval");
  });

  it("answers null for a body that is not a request template, rather than throwing", () => {
    expect(readRequestTemplate({})).toBeNull();
    expect(readRequestTemplate(withItems(item({ dueOffsetDays: 0 })))).toBeNull();
    expect(readRequestTemplate({ label: "A process", steps: [] })).toBeNull();
  });
});

describe("requestDates — offsets from the period's LAST day", () => {
  it("asks October's monthly close on 1 November, due on the 5th", () => {
    expect(requestDates("2025-10-31", { sendOffsetDays: 1, dueOffsetDays: 5 })).toEqual({
      sendOn: "2025-11-01",
      dueOn: "2025-11-05",
    });
  });

  it("send 0 is the period's last day itself", () => {
    expect(requestDates("2025-09-30", { sendOffsetDays: 0, dueOffsetDays: 1 })).toEqual({
      sendOn: "2025-09-30",
      dueOn: "2025-10-01",
    });
  });

  it("crosses the year boundary: 2025-12-31 plus one is 2026-01-01", () => {
    expect(requestDates("2025-12-31", { sendOffsetDays: 1, dueOffsetDays: 10 })).toEqual({
      sendOn: "2026-01-01",
      dueOn: "2026-01-10",
    });
  });

  it("knows a leap February from an ordinary one", () => {
    // January's period end plus 29 lands on the 29th only in a leap year.
    expect(requestDates("2024-01-31", { sendOffsetDays: 1, dueOffsetDays: 29 }).dueOn).toBe("2024-02-29");
    expect(requestDates("2025-01-31", { sendOffsetDays: 1, dueOffsetDays: 29 }).dueOn).toBe("2025-03-01");
    // And a leap February's own period ends on the 29th.
    expect(requestDates("2024-02-29", { sendOffsetDays: 1, dueOffsetDays: 5 })).toEqual({
      sendOn: "2024-03-01",
      dueOn: "2024-03-05",
    });
  });

  it("reaches the far end of the bounds across months", () => {
    expect(requestDates("2025-03-31", { sendOffsetDays: 90, dueOffsetDays: 120 })).toEqual({
      sendOn: "2025-06-29",
      dueOn: "2025-07-29",
    });
  });

  it("refuses a period end that is not a real day, rather than rolling it into another month", () => {
    for (const bad of ["2025-02-29", "2025-13-01", "31/10/2025", ""]) {
      expect(() => requestDates(bad, { sendOffsetDays: 1, dueOffsetDays: 5 }), bad).toThrow(
        /periodEnd must be the period's last day as YYYY-MM-DD/,
      );
    }
  });
});

describe("the ask kinds a template may name", () => {
  it("are exactly the ask's own kinds (domain/clientask)", () => {
    // Restated in the config domain because asks depend on templates and not
    // the other way round; this is the one place both may be read.
    expect([...REQUEST_ASK_KINDS].sort()).toEqual([...ASK_KINDS].sort());
  });
});

describe("a request template through the registry", () => {
  it("is defined as a draft, published, and read back by key", async () => {
    const fakes = makeConfigFakes();
    const service = new ConfigService(fakes);
    const { entry, draft } = await service.define(
      { tenantId: TENANT, kind: "request_template", key: "monthly-close", body: monthlyClose() },
      ACTOR,
    );
    expect(entry.kind).toBe("request_template");
    expect(draft.status).toBe("draft");

    await service.publish(
      { tenantId: TENANT, kind: "request_template", key: "monthly-close", version: 1 },
      ACTOR,
    );
    const [listed] = await service.list(TENANT, "request_template");
    expect(listed?.entry.key).toBe("monthly-close");
    expect(listed?.published?.status).toBe("published");
    const read = readRequestTemplate(listed?.published?.body ?? {});
    expect(read?.items).toHaveLength(4);
    expect(read?.items.map((i) => i.key)).toContain("bank_statements");
  });

  it("keeps version 1 readable by its pin after version 2 adds an item", async () => {
    const fakes = makeConfigFakes();
    const service = new ConfigService(fakes);
    const { draft: v1 } = await service.define(
      { tenantId: TENANT, kind: "request_template", key: "monthly-close", body: monthlyClose() },
      ACTOR,
    );
    await service.publish({ tenantId: TENANT, kind: "request_template", key: "monthly-close", version: 1 }, ACTOR);

    const v2Body = monthlyClose();
    (v2Body["items"] as Item[]).push(
      item({ key: "expenses", label: "Expense claims with receipts" }),
    );
    await service.addVersion({ tenantId: TENANT, kind: "request_template", key: "monthly-close", body: v2Body });
    await service.publish({ tenantId: TENANT, kind: "request_template", key: "monthly-close", version: 2 }, ACTOR);

    // What October's asks were raised from still says four items.
    const pinned = await service.readPinned(TENANT, v1.id);
    expect(pinned.status).toBe("archived");
    expect(readRequestTemplate(pinned.body)?.items).toHaveLength(4);
    // And what is in force now says five.
    const [listed] = await service.list(TENANT, "request_template");
    expect(readRequestTemplate(listed?.published?.body ?? {})?.items).toHaveLength(5);
  });

  it("refuses an invalid body at the write, with the domain's sentence", async () => {
    const service = new ConfigService(makeConfigFakes());
    const err = await service
      .define(
        {
          tenantId: TENANT,
          kind: "request_template",
          key: "monthly-close",
          body: withItems(item({ sendOffsetDays: 5, dueOffsetDays: 2 })),
        },
        ACTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidBody);
    expect((err as Error).message).toContain('items[0] ("purchases").dueOffsetDays is 2');
  });
});
