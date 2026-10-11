// Which failures fin calls "unavailable" (F0.6) — the one list every fin
// adapter shares, so it is pinned here: a code that drifts in or out of it
// changes what a fin screen tells a firm, in one direction or the other.
import { describe, expect, it } from "vitest";
import {
  asFinUnavailable,
  finUnavailableOnFailure,
  isFinUnavailable,
} from "../../src/infrastructure/fin/unavailable";
import { FinUnavailable } from "../../src/domain/fin/errors";

function pgError(code: string): Error {
  return Object.assign(new Error(`postgres said ${code}`), { code });
}

describe("what counts as fin's database not answering", () => {
  it.each([
    ["57014", "the statement timeout fired"],
    ["57P01", "the server is shutting down"],
    ["57P03", "the server is not accepting connections yet"],
    ["53300", "no connection slot left"],
    ["08006", "the connection failed"],
    ["08001", "the client could not connect"],
    ["ECONNREFUSED", "nothing listening"],
    ["ECONNRESET", "the connection was reset"],
    ["CONNECT_TIMEOUT", "postgres.js gave up connecting"],
    ["CONNECTION_CLOSED", "the connection closed under a query"],
  ])("%s (%s)", (code) => {
    expect(isFinUnavailable(pgError(code))).toBe(true);
  });

  it("counts a refused connection Node reports as an AggregateError", () => {
    const both = new AggregateError([pgError("ECONNREFUSED"), pgError("ECONNREFUSED")], "connect failed");
    expect(isFinUnavailable(both)).toBe(true);
  });

  it.each([
    ["23505", "a unique violation is a conflict"],
    ["42501", "a permission error is a bug in the grants"],
    ["42P01", "a missing table is a bug in a migration"],
    ["22012", "a division by zero is a bug in a query"],
    ["40001", "a serialization failure is a conflict to retry, not an outage"],
  ])("NOT %s (%s)", (code) => {
    expect(isFinUnavailable(pgError(code))).toBe(false);
  });

  it("NOT an error with no code at all, which is ours", () => {
    expect(isFinUnavailable(new Error("a bug"))).toBe(false);
    expect(isFinUnavailable("a string")).toBe(false);
    expect(isFinUnavailable(null)).toBe(false);
  });
});

describe("the translation", () => {
  it("turns an unavailable failure into FinUnavailable and keeps the cause for the log", () => {
    const cause = pgError("57014");
    const out = asFinUnavailable(cause, "the intake list");
    expect(out).toBeInstanceOf(FinUnavailable);
    expect((out as FinUnavailable).cause).toBe(cause);
    expect((out as FinUnavailable).what).toBe("the intake list");
  });

  it("passes every other failure through unchanged, so it still reaches the mapper as itself", () => {
    const conflict = pgError("23505");
    expect(asFinUnavailable(conflict, "anything")).toBe(conflict);
  });

  it("does not wrap a FinUnavailable twice", () => {
    const once = new FinUnavailable("the intake list");
    expect(asFinUnavailable(once, "again")).toBe(once);
  });

  it("wraps a read", async () => {
    await expect(
      finUnavailableOnFailure("a read", () => Promise.reject(pgError("ECONNREFUSED"))),
    ).rejects.toBeInstanceOf(FinUnavailable);
    await expect(finUnavailableOnFailure("a read", () => Promise.resolve(7))).resolves.toBe(7);
  });
});
