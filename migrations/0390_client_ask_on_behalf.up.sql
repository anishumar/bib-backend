-- 0390 · A file the FIRM uploads for the client, answering an ask
--         (docs/FIN_BUILD_PLAN.md F1.6, 2026-10-11).
--
-- ── WHY THE EXISTING COLUMNS CANNOT SAY IT ────────────────────────────────
--
-- A client asked for their October bank statements does not always open the
-- portal: they email them to their accountant. Until now the firm had two bad
-- choices. Upload them through the documents panel, where they are filed but the
-- ask stays "Waiting on them" and the chaser goes on reminding a client who has
-- already sent everything; or leave the files in a mailbox, where FinCompliance
-- never takes them in. So a colleague may now upload the files ON the ask, and
-- they are stored exactly as the client's own upload would be: the kind the
-- firm chose when it asked, `origin = 'uploaded'`, the ask's client as the
-- document's party, filed against the work item, one response row each, the
-- ask turned answered.
--
-- What cannot be the same is WHO. `responded_by` is NOT NULL (0063) and names
-- the person who did it, and here that is the colleague: writing the client's
-- contact would put a name on an act that person did not perform, and the
-- ledger records the colleague as the actor for the same reason. But a STAFF id
-- in `responded_by` alone does not say "on the client's behalf": telling the
-- two sides apart by asking whether the account holds a staff membership is a
-- join that decides attribution (0068 refused exactly that for `author_side`),
-- and an account that is staff at one firm and a client contact at another
-- would change sides in an old conversation. So the fact is a COLUMN, written
-- with the row and never moved.
--
-- ── `on_behalf`, FALSE BY DEFAULT ─────────────────────────────────────────
--
-- Every response before 0390 is the client's own, so the default is the truth
-- for them and applying this changes no row's meaning. The table is
-- append-only by GRANT (0063: SELECT and INSERT, UPDATE revoked), so the flag
-- can never be set after the fact either way. A table-level INSERT privilege
-- covers a column added later, so no grant is needed.
--
-- No CHECK ties it to `response_kind = 'document'`. The only writer today is
-- the upload, but "the client told us on the phone that they hold no such
-- register" is the same shape of fact, and a CHECK would turn that into a
-- migration instead of a route.
--
-- ── AND A CLIENT CANNOT WRITE IT ──────────────────────────────────────────
--
-- A portal session marking its own response as the FIRM's would put the firm's
-- name on something a client did, on the firm's own screen. The portal adapter
-- never writes the column, but that is the code's correctness rather than a
-- wall, so a RESTRICTIVE INSERT policy says it: a portal session's response is
-- never on the client's behalf. The guard is 0062's shape (`NOT
-- crm.is_portal_session() OR …`), because a bare `NOT on_behalf` on a
-- restrictive policy applies to every session and would stop the FIRM writing
-- the very rows this migration exists for.
--
-- ── WHO SEES THE FILE: the client does, and that is the T6.7 rule ─────────
--
-- Not decided here (the adapter writes `files.document.is_client_visible`), but
-- recorded where the column lives: an on-behalf file is client-visible, as the
-- portal upload is. It is the client's own file, sent another way; the same
-- file uploaded through the portal would be visible, and storing it "exactly as
-- the client's upload would be" means the same state. The response row is on
-- the client's action centre either way (gate 4 on this table is the party),
-- and an invisible document would make it a reply about nothing. The firm can
-- still take it off the portal with the document's own switch.
SET ROLE bib_owner;

ALTER TABLE delivery.client_ask_response
  ADD COLUMN on_behalf boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN delivery.client_ask_response.on_behalf IS
  'True when somebody at the FIRM recorded this response for the client (0390, F1.6): files the client sent another way, uploaded on the ask. responded_by is then that colleague. False for every response the client gave themselves, which is every row before 0390.';

CREATE POLICY client_ask_response_on_behalf_firm_only ON delivery.client_ask_response
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (NOT crm.is_portal_session() OR NOT on_behalf);

RESET ROLE;
