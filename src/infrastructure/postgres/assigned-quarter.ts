// THE CLIENT'S ASSIGNED QUARTER (Q071 d) for one engagement, in SQL: a
// correlated subquery over an engagement aliased `e` and its letter line `ll`.
//
// The month (1-3) the client company's quarters start in for a tax whose
// rule is AUTHORITY-ASSIGNED (0359) and carried by the engagement's service
// (T6.16, on the rule's lineage), from what the client has recorded and not
// cleared (0360). The tax is matched as the calendar and Setup match it: the
// rule's module, upper-cased. Null when nothing applies. Several taxes with
// different quarters on one service would be unusual; the earliest month is
// taken so the answer is stable.
//
// A constant fragment with no parameters, which is what makes `db.unsafe`
// safe to put it in.
export const ASSIGNED_QUARTER_MONTH = `(
  SELECT min(rp.first_month)::int
    FROM config.version pv
    JOIN delivery.obligation_rule_service k
      ON k.tenant_id = pv.tenant_id AND k.service_entry_id = pv.entry_id AND k.unlinked_at IS NULL
    JOIN delivery.obligation_template t
      ON t.tenant_id = k.tenant_id AND t.lineage_id = k.lineage_id
     AND t.is_active AND t.status = 'confirmed' AND t.period_basis = 'authority_assigned'
    JOIN core.legal_entity_return_period rp
      ON rp.tenant_id = e.tenant_id AND rp.entity_party_id = e.entity_party_id
     AND rp.tax = upper(btrim(t.module)) AND rp.frequency = 'quarterly' AND rp.cleared_at IS NULL
   WHERE pv.id = ll.service_version_id AND pv.tenant_id = ll.tenant_id
)`;
