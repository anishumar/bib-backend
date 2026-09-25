-- 0305 down · an archived party may be referenced again, as before 0305.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS engagement_not_to_archived_party ON crm.engagement;
DROP TRIGGER IF EXISTS engagement_letter_line_not_to_archived_party ON crm.engagement_letter_line;
DROP TRIGGER IF EXISTS engagement_letter_not_to_archived_party ON crm.engagement_letter;
DROP TRIGGER IF EXISTS proposal_line_not_to_archived_party ON crm.proposal_line;
DROP TRIGGER IF EXISTS proposal_not_to_archived_party ON crm.proposal;
DROP TRIGGER IF EXISTS lead_not_to_archived_party ON crm.lead;
DROP FUNCTION IF EXISTS core.refuse_reference_to_archived_party();

RESET ROLE;
