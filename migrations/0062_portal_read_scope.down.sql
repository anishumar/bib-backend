-- Undo 0062. Dropping a wall is not a neutral act: after this runs, a portal
-- session reaching `delivery.obligation_instance` reads every company's filings
-- in the firm, and a task the firm marked internal is readable by the client it
-- is about. Both are refused by gate 2 today only because no route selects them
-- outside `usecase/portalhome` — which is exactly the "there is nothing here
-- yet" defence 0059 was written to stop relying on.
--
-- The order is the reverse of the up: the policies name the function.

SET ROLE bib_owner;

DROP POLICY IF EXISTS obligation_instance_portal_scope ON delivery.obligation_instance;
DROP POLICY IF EXISTS work_item_portal_visible ON delivery.work_item;
DROP FUNCTION IF EXISTS crm.is_portal_session();

RESET ROLE;
