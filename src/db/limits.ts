// The ceiling on a list read.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// It is NOT pagination. A cursor with a page size is what these endpoints
// should eventually have, the way `/api/v1/events` already does, and that is
// product work: it changes response shapes, the generated client and every
// screen that renders one of these lists.
//
// This is the thing that has to be true BEFORE that work happens. Most list
// queries in this repository had no `LIMIT` at all — 66 list methods, 23 of
// them capped — so `GET /api/v1/work-items` meant "SELECT every work item this
// firm has ever had", assembled into JSON in memory, on a request any
// authenticated user can make. RLS scopes it to one firm, so it is a firm
// harming itself rather than a leak; it is still a query whose cost grows
// forever and has no upper bound anywhere.
//
// ── WHY THIS NUMBER ─────────────────────────────────────────────────────────
//
// Five thousand rows is far past what any of these screens can usefully render
// — a person does not read five thousand work items — and far short of what
// hurts the process. So for every real firm the cap is invisible, and the case
// where it bites is one where the screen was already unusable.
//
// The honest cost, stated rather than discovered: a firm past the cap sees the
// first five thousand rows in the query's own order and is not told there are
// more. That is a real shortcoming and it is why the cursor work is on the
// board. It is a better shortcoming than the unbounded read it replaces.
//
// Applied only to lists that grow WITHOUT BOUND over a firm's lifetime — work
// items, invoices, leads, parties, engagement letters, escalations, client
// requests. A list bounded by something else (the lines of ONE invoice, the
// clauses of ONE letter, a firm's roles) needs no ceiling, and adding one would
// be noise.
export const MAX_LIST_ROWS = 5000;
