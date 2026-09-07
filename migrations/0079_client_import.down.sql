-- Down for 0079.
--
-- The staging table goes, and with it every uploaded sheet and every report —
-- but NOT one client, letter or assignment an import created. Those went in
-- through the ordinary services and live in `core` and `crm` like anything
-- typed in; the ledger events naming them survive too, pointing at an import
-- id that no longer resolves, which is the honest state of a rolled-back
-- feature.
--
-- Nothing here can fail halfway: one table, nothing references it, and no
-- vocabulary was widened for it. `tenancy.set_updated_at()` belongs to 0001
-- and stays.

SET ROLE bib_owner;

DROP TABLE IF EXISTS crm.client_import;

RESET ROLE;
