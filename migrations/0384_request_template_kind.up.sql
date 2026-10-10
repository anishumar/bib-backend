-- 0384 · The request template — the registry's THIRTEENTH kind (F1.1,
--         docs/FIN_BUILD_PLAN.md, "F1 contract" fixed 2026-10-10)
--
-- ── WHAT IT IS ──────────────────────────────────────────────────────────────
--
-- What a firm asks a client for, every period, and when: "Monthly close" is
-- the purchase invoices, the sales invoices, the bank statements and the
-- expense claims, asked for on the 1st and due by the 5th. Today that list
-- lives in a partner's head and goes out as an email at the start of each
-- month; T6.6 built the ask a client answers and nothing raises one unless a
-- person remembers to.
--
-- A body is `{ label, items: [{ key, label, askKind, documentKind,
-- sendOffsetDays, dueOffsetDays }] }`, validated in `domain/config/model.ts`.
-- Both offsets count from the period's LAST day, because a month's papers
-- exist only once the month is over: October with send 1 and due 5 is asked
-- on 1 November and due on 5 November. A document item names the kind its
-- upload is filed as, and a client's books files name `books_input` (0383),
-- the one kind fin takes in.
--
-- ── WHY A KIND AND NOT A TABLE ──────────────────────────────────────────────
--
-- It passes the registry's own test the way `dunning` did: the items and the
-- days are the firm's, they change, and a partner should move them without a
-- deploy. And it needs the registry's PIN. "What did we ask this client for in
-- October" has to answer with October's list after the firm has added a fifth
-- item in November, so each ask records the `config.version` it was raised
-- from (0385, the ask's half), and a published version is frozen (0005).
--
-- ── WHERE IT IS READ, AND HOW ────────────────────────────────────────────────
--
-- A `workflow_template` step names one by KEY (`requestTemplateKey`), read
-- LIVE when the job reaches the step, as `verificationPolicyKey` is. The job
-- pins its process; the list it asks a client for is not part of the process
-- and is pinned where it is used, on the ask. No migration for that half: a
-- workflow body is jsonb, the field is optional, and every process already
-- published reads exactly as before (absent means the step asks for nothing).
--
-- ── NOTHING IS SEEDED ───────────────────────────────────────────────────────
--
-- A firm with no request template asks its clients for nothing automatically,
-- which is exactly what every firm does today, so applying this changes no
-- firm's behaviour. "Monthly close" is seeded with its screen (F1.7), once 10x
-- has confirmed the list.

SET ROLE bib_owner;

-- Rewritten in full rather than added to, as 0067 did and for its reason:
-- `entry_kind_check` is a CHECK and there is no way to extend one in place. The
-- list is the union of every kind up to and including this one.
ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry ADD CONSTRAINT entry_kind_check CHECK (kind = ANY (ARRAY[
  'service', 'role', 'policy', 'clause', 'dunning', 'workflow_template',
  'confidence_tier', 'verification_policy', 'compliance_policy', 'escalation',
  'chaser', 'nudge', 'request_template'
]));

RESET ROLE;
