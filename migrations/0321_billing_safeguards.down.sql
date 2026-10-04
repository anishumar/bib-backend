-- Down for 0321.
--
-- Drops the claim and the switch's date. It does NOT put the old partner and
-- manager role bodies back, for the reason 0012's, 0045's, 0056's, 0060's,
-- 0064's, 0069's and 0317's downs all give: publishing archived the version it
-- replaced, and a firm that has published its OWN role since would have that
-- overwritten by a rollback it never asked for. With the code gone, a role still
-- listing `billing:skip` grants nothing.

SET ROLE bib_owner;

ALTER TABLE tenancy.tenant DROP COLUMN auto_billing_since;
ALTER TABLE crm.billing_due DROP COLUMN claimed_at;

RESET ROLE;
