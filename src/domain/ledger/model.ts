// The ledger domain — the event contract itself (T1.1). Nouns + pure rules,
// stdlib only. This file is the vocabulary BOTH lanes write against: the
// commercial lane and the delivery lane meet here and at the engine's trigger
// contract, so a change to it is a cross-lane conversation, not a local edit.
//
// Three rules give the log its value, and all three are enforced below rather
// than trusted:
//   1. The verb is from a CLOSED registry. An unregistered verb is a typo, and
//      a typo in an append-only log is permanent: it creates a verb nothing
//      queries and silently drops the event out of every timeline that matters.
//   2. object_type is DERIVED from the verb, never passed in — so the pair can
//      never disagree and no caller has to remember the mapping.
//   3. The payload carries ids and machine facts, never personal data. Erasure
//      (DPDP / GDPR) must never require mutating an immutable log, so personal
//      data stays in erasable rows and is referenced by id from here.
//
// The prose version, with worked examples, is docs/EVENT-CONTRACT.md.

/** Who acted. `system` is the platform itself (a scheduler tick, a boot job);
 *  `agent` is an AI executor; `human` is a logged-in person. */
export type ActorType = "human" | "agent" | "system";

export interface Actor {
  readonly type: ActorType;
  /** The user id (human) or the registered agent id. Null only for `system`. */
  readonly id: string | null;
}

/** The `system` actor, as a value — so a scheduler or migration job does not
 *  have to construct one and get the null right. */
export const SYSTEM_ACTOR: Actor = { type: "system", id: null };

export interface DomainEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly verb: EventVerb;
  readonly objectType: string;
  readonly objectId: string;
  readonly payload: Record<string, unknown>;
  /** When it happened in the business. ISO 8601 with offset. */
  readonly occurredAt: string;
  /** When we learned of it. ISO 8601 with offset. Set by the database. */
  readonly recordedAt: string;
}

// ── The verb registry — the agreed vocabulary ────────────────────────────────

/** Which lane owns the verb. Documentation, not a permission: any service may
 *  read any event; the lane says who is expected to WRITE it. */
export type Lane = "platform" | "commercial" | "delivery";

export interface VerbSpec {
  /** The kind of row `objectId` points at. Derived, never passed by a caller. */
  readonly objectType: string;
  readonly lane: Lane;
  readonly description: string;
}

/**
 * Every verb the system may record. Past tense, dotted, `<subject>.<happened>`.
 *
 * Adding one is a one-line change here plus a line in docs/EVENT-CONTRACT.md —
 * deliberately cheap, deliberately visible. The registry is code and not a
 * database table precisely so that adding a verb is reviewed like code; a
 * lookup table would let a typo become a permanent new verb at runtime.
 */
export const EVENT_VERBS = {
  // ── platform · tenancy + party (the spine) ─────────────────────────────────
  "tenant.created":              { objectType: "tenant",              lane: "platform",   description: "A firm was registered as a tenant." },
  "tenant.suspended":            { objectType: "tenant",              lane: "platform",   description: "A firm was suspended by the PLATFORM. Every session pointed at it loses its tenant context on its next request — `resolveSession` reads `tenant.status`, so this takes effect immediately rather than at session expiry. Not something a firm can do to itself: the only route is /internal." },
  "tenant.reinstated":           { objectType: "tenant",              lane: "platform",   description: "A suspended firm was let back in. Sessions that survived the suspension resume working on their next request; ones that expired meanwhile are gone, like any other." },
  "membership.granted":          { objectType: "membership",          lane: "platform",   description: "A user was given a role in a tenant, for one audience." },
  "membership.revoked":          { objectType: "membership",          lane: "platform",   description: "A membership was deactivated. The person's next request stops — resolveSession re-reads this on every one." },
  "membership.restored":         { objectType: "membership",          lane: "platform",   description: "A deactivated membership was reinstated." },
  "membership.role_changed":     { objectType: "membership",          lane: "platform",   description: "A member's role at a firm changed, and with it everything gate 3 lets them do." },
  "membership.grade_changed":    { objectType: "membership",          lane: "platform",   description: "A member's SENIORITY changed — a different axis from role. It decides who may sign off another person's work, so who moved whom, and when, is exactly what gets asked about later." },
  "membership.reports_to_changed": { objectType: "membership",          lane: "platform",   description: "Who a member reports to changed. Read by one thing — a `reporting_line` verification policy deciding who may check their work — so 'who was my manager in March' is asked of this trail, because the column itself is not effective-dated." },

  // ── platform · the seniority ladder (G3.3) ────────────────────────────────
  // Separate from role: the role says what somebody may REACH, the grade says
  // how senior they are. A firm owns its own ladder, so every change to it is
  // recorded — a rung's rank is what the review threshold compares against, and
  // moving one silently changes who may approve a statutory filing.
  "staff_grade.created":         { objectType: "staff_grade",         lane: "platform",   description: "A firm added a rung to its own hierarchy — one its starting ladder did not have." },
  "staff_grade.updated":         { objectType: "staff_grade",         lane: "platform",   description: "A rung was renamed, re-ranked, or stopped/resumed being promoted through. The payload carries both sides of whatever changed. Never a delete: a rung somebody held is part of why they could approve something." },
  // ── platform · the firm's own delivery structure (G2.4) ───────────────────
  // Depts (the revenue axis) and delivery teams (who does the work) are the
  // firm's own org chart, and once `work_split_axis` names one of them it also
  // decides how a client's work is cut into separate jobs. Retiring a Dept
  // therefore changes what the engine does next, which is why it is recorded
  // rather than left as a boolean nobody can date.
  "service_axis.created":        { objectType: "service_axis",        lane: "platform",   description: "A firm added a Dept or a delivery team to its own structure." },
  "service_axis.updated":        { objectType: "service_axis",        lane: "platform",   description: "A Dept or delivery team was renamed or reordered. The payload names the CODE and says which of the two changed — the code is what every service body joins on and it never moves." },
  "service_axis.retired":        { objectType: "service_axis",        lane: "platform",   description: "A firm stopped filing new work under a Dept or delivery team. NOT a delete: services already naming it keep it and still read." },
  "service_axis.reactivated":    { objectType: "service_axis",        lane: "platform",   description: "A retired Dept or delivery team was brought back into use." },
  "work_split_axis.changed":     { objectType: "tenant",              lane: "platform",   description: "A firm changed how one client's work is cut into separate jobs — by Dept, by delivery team, or not at all. The payload carries BOTH sides: \"what did it used to be\" is the question asked when a job looks split the wrong way." },
  "tenant.time_zone_changed":   { objectType: "tenant",              lane: "platform",   description: "A firm changed which calendar its months and days are cut on — the client month view and the chaser's day arithmetic. The payload carries BOTH sides, because \"why did this filing move month\" is asked afterwards and the old value is the answer." },
  "tenant.auto_billing_set":    { objectType: "tenant",              lane: "platform",   description: "A firm turned automatic billing on or off (0318). On, the daily sweep writes a bill due for every recurring engagement whose billing is set up; off, it writes nothing. Payload: `from`, `to`." },
  "grade_ladder.seeded":         { objectType: "tenant",              lane: "platform",   description: "A new tenant's seniority ladder was initialised from the product defaults. One event, not one per rung." },
  "user.renamed":                { objectType: "user_account",        lane: "platform",   description: "A person corrected their own display name (V2.5). Recorded in the firm the session was acting as; the payload names the field, never the name." },
  "session.started":             { objectType: "user_account",        lane: "platform",   description: "A user's session became active in THIS tenant — at login, or when the org switcher selected it." },
  "party.created":               { objectType: "party",               lane: "platform",   description: "An organization or person party was created." },
  "party.archived":              { objectType: "party",               lane: "platform",   description: "A party was put away — hidden from pickers and lists. NOT a delete: parties are permanent, the row still resolves by id forever, and every document pointing at it still renders. Refused while a LIVE lead, proposal, engagement letter, letter line or engagement still points at it (0035; since 0314 an open lead, a draft or sent document, a pending, active or paused engagement) — a DELETED one does not count (0086)." },
  "party.unarchived":            { objectType: "party",               lane: "platform",   description: "An archived party was brought back into the pickers and lists." },
  "firm_entity.edited":          { objectType: "party",               lane: "platform",   description: "One of the firm's OWN companies had its name, entity type or registered address changed (T6.18). Payload: which fields changed — never the name or the address, which the row keeps." },
  "party.updated":               { objectType: "party",               lane: "platform",   description: "A client's master data was corrected (V2.5): its display name, trade name, industry or website. Payload: the NAMES of the fields that changed, never their old or new values (a person's name is personal data, and this log cannot be erased)." },
  "legal_entity.corrected":      { objectType: "legal_entity",        lane: "platform",   description: "A registered company's country or kind was corrected (V2.5). Payload: which of the two changed, and the new jurisdiction and entity type, which are business facts about a company." },
  "party_identifier.ended":      { objectType: "party_identifier",    lane: "platform",   description: "An identifier stopped being in force on a day (V2.5), a GSTIN cancelled say. Payload: the party and the identifier's TYPE and end day, never its value. An ended identifier no longer blocks the value elsewhere." },
  "party_identifier.voided":     { objectType: "party_identifier",    lane: "platform",   description: "An identifier entered by mistake was voided (V2.5, 0315): kept, shown as voided, final, and no longer blocking the value. Payload: the party and the identifier's TYPE, never its value." },
  "legal_entity.registered":     { objectType: "legal_entity",        lane: "platform",   description: "An organization was registered as a legal entity in a jurisdiction." },
  "party_identifier.added":      { objectType: "party_identifier",    lane: "platform",   description: "A PAN / GSTIN / handle was attached to a party." },
  "party_relationship.recorded": { objectType: "party_relationship",  lane: "platform",   description: "An effective-dated relationship between two parties was recorded." },
  "party_relationship.ended":    { objectType: "party_relationship",  lane: "platform",   description: "A relationship was closed with a valid_to date." },

  // ── platform · who at the firm owns a client (G3.2) ───────────────────────
  // Effective-dated rows, so the TABLE already answers "who was the SPOC in
  // March". These two events answer the different question the table cannot:
  // WHO DECIDED, and when they decided it. A handover names the row it closed,
  // because otherwise one act looks like two unrelated events on one day.
  "client_assignment.created":   { objectType: "client_assignment",   lane: "platform",   description: "Somebody at the firm was put in charge of a client — the Key Manager, or a SPOC for one Dept or delivery team. A key-manager handover carries `handedOverFrom`, naming the assignment it closed in the same transaction." },
  "client_assignment.ended":     { objectType: "client_assignment",   lane: "platform",   description: "An assignment was closed — somebody stopped holding a client, with nobody named in their place. NOT a delete: the row stays and is what answers who held it before. The payload carries the date it stopped being in force, which is the FIRST DAY NOT IN FORCE." },

  // ── platform · loading a firm's existing book (client import) ─────────────
  // The staging row is the object. Both payloads are COUNTS: the sheet carries
  // names, emails and registration numbers, and this log cannot be erased.
  "client_import.staged":        { objectType: "client_import",       lane: "platform",   description: "A spreadsheet of the firm's existing clients was uploaded, parsed and checked against what the firm already has — and STAGED with its report. Nothing else was written; a row already on file is skipped, never updated." },
  "client_import.confirmed":     { objectType: "client_import",       lane: "platform",   description: "A staged import was loaded: every row went through the ordinary party, assignment and engagement services, so each client, letter and assignment it created has its own event. The payload carries what was created, skipped and failed, by count." },

  // GATE 4 (G3.4). The table is effective-dated and already answers "who could
  // see this client in March"; these answer what it cannot — WHO DECIDED to let
  // them in, and who took it away. NO NAMES in either payload: the client's name
  // and the contact's email are personal data about people outside the firm, and
  // this log cannot be erased.
  "portal_access.granted":       { objectType: "portal_access",       lane: "platform",   description: "A client-portal login was allowed to read one client's records. ONE CLIENT PER EVENT, deliberately: a contact who may see four companies has four grants and four of these, so who decided each one is answerable. Access is never derived from a group relationship." },
  "portal_access.ended":         { objectType: "portal_access",       lane: "platform",   description: "A portal login stopped being able to read a client's records. NOT a delete: the row stays, which is what makes \"could this person see this on 14 March\" answerable a year later. The payload carries the FIRST DAY NOT IN FORCE." },

  // The letter, sent AGAIN. Recorded because it is the one act in this product
  // that mails a credential to somebody outside the firm on a staff member's
  // say-so, and because the question asked afterwards is never "did they get
  // in" — it is WHO kept sending it, and how often. The address is not in the
  // payload and cannot be: it is personal data (3.4), and it is also the fact
  // this route deliberately cannot change.
  "portal_invitation.resent":    { objectType: "membership",          lane: "platform",   description: "A client contact's portal invitation was sent again — same person, same address, which is the only shape this route has. The payload carries how many still-live invitations it superseded: issuing a new one spends the old, so a contact never holds two password setters at once. NO EMAIL in the payload; the membership id is who." },

  // ── platform · the configuration registry (P2 / T2.5) ─────────────────────
  // Configuration decides what everyone else may do, so who changed it, when,
  // and to which version is exactly what gets asked about later. Only versions
  // that took EFFECT are recorded: a draft changes nothing until it is
  // published, and the publish names the person who made it real.
  "config_entry.created":        { objectType: "config_entry",        lane: "platform",   description: "A configured thing (a service, a role) was defined, with its first draft." },
  "config_version.published":    { objectType: "config_version",      lane: "platform",   description: "A configuration version took effect and froze. Anything pinned to the version it replaced still reads that one." },
  "config_version.archived":     { objectType: "config_version",      lane: "platform",   description: "A configuration version stopped being what is in force. It stays readable — pins resolve to it forever." },
  "config_registry.seeded":      { objectType: "tenant",              lane: "platform",   description: "A new tenant's configuration registry was initialised from the product defaults. One event, not one per row." },
  "firm_entity_preference.set":  { objectType: "firm_entity_preference", lane: "platform", description: "The firm said which of its OWN entities issues documents to clients in a country — or set the fallback that answers for every country it has no entity in. A commercial and legal decision (it settles governing law, courts and who the client's counterparty is), so who made it is the point of the record." },
  "territory_rule.set":          { objectType: "territory_rule",       lane: "commercial", description: "The firm said whose desk covers leads from a country — or moved one. It decides who a new opportunity lands on before anybody has looked at it, so who drew the line and when is the record. The NOTE is not in the payload: it is prose a person wrote, and this log cannot be erased." },
  "standard_document_block.set": { objectType: "standard_document_block", lane: "platform", description: "The firm changed its STANDARD prose — an exclusion, a commercial note, a line of the team block — or retired one. It is logged because the standard set is what every document written from here on will say, and 'why does this letter carry this exclusion' is answered by who changed it and when. The BODY is not in the payload: it is prose a person wrote, this log cannot be erased, and the row keeps it where it can be." },
  "firm_signatory.set":          { objectType: "tenant",              lane: "platform",   description: "The firm named who binds it — the person and the capacity printed under 'Yours sincerely' on every letter it sends from now on. Authority to bind is an audit question and a DIFFERENT fact from who operated the system, which is this event's actor. objectType is the tenant because the standing signatory is a column on it, the same shape config_registry.seeded uses." },

  // ── commercial lane (A) · sell → bill → collect ────────────────────────────
  "lead.captured":               { objectType: "lead",                lane: "commercial", description: "A lead entered the pipeline." },
  "lead.merged":                 { objectType: "lead",                lane: "commercial", description: "A duplicate capture landed on an existing open lead instead of starting a rival one." },
  "lead.stage_changed":          { objectType: "lead",                lane: "commercial", description: "A lead moved through the pipeline. Reaching a terminal stage closes it." },
  "lead.owner_assigned":         { objectType: "lead",                lane: "commercial", description: "A lead was put on somebody's desk, or taken off it." },
  "lead.details_changed":        { objectType: "lead",                lane: "commercial", description: "Where a prospect is, or what the opportunity could be worth, was set or corrected. Both sides of each travel in the payload: a country code and an amount name nobody." },
  "lead.deleted":                { objectType: "lead",                lane: "commercial", description: "A lead entered by mistake was deleted (0086): out of the pipeline and every count, still readable by id, and final. NOT an outcome — lost and abandoned are what happened to a real prospect; this says there was none. Refused once converted or while a live proposal was drafted from it, and a lead already closed as lost or abandoned is deleted by an administrator only. Payload: the party and the stage it had reached — never the title, which names the counterparty." },
  "proposal.drafted":            { objectType: "proposal",            lane: "commercial", description: "A proposal was drafted for a party — the first row in its own timeline, and the only record of what was quoted before it went out." },
  "proposal.deleted":            { objectType: "proposal",            lane: "commercial", description: "A draft made by mistake was deleted before it went out (0086): off the list of quotes, still readable by id, and final. Its reference is not reused — a proposal reference may gap. Refused once sent, or while a live letter cites it. Payload: the reference and the party — never the title." },
  "proposal.copied":             { objectType: "proposal",            lane: "commercial", description: "A rejected or expired proposal was copied into a new draft (0316), recorded against the OLD one so its timeline says where the work went. The old proposal does not change. Payload: the new draft's id and reference, and counts of the lines and prose copied — never the title." },
  "proposal.discount_approved":  { objectType: "proposal",            lane: "commercial", description: "A discount past the firm's published limit was signed off, by somebody holding proposal:approve. The whole value of the record is WHO." },
  "proposal.issuer_changed":     { objectType: "proposal",            lane: "commercial", description: "A DRAFT was moved to another of the firm's own companies (T6.18): who would contract with the client changed before anything went out, and its prose was replaced with that company's standard set. Payload: the two companies, whether prose was replaced and how many lines edited for this client went with it." },
  "proposal.currency_changed":   { objectType: "proposal",            lane: "commercial", description: "A DRAFT's currency or its rate back to the firm's reporting currency changed (T6.18) — the currency only while it quoted nothing. Payload: both currencies and both rates, and the rate's day." },
  "proposal.discount_approval_lapsed": { objectType: "proposal",       lane: "commercial", description: "A draft's discount sign-off stopped covering it (T6.18): a line's discount was raised, or a line added, past the firm's limit after the approval was given. The draft needs signing off again before it can be sent. Payload: who had approved it, the line, its new discount and the limit it was judged against." },
  "proposal.sent":               { objectType: "proposal",            lane: "commercial", description: "A proposal was sent to a prospect." },
  "proposal.emailed":            { objectType: "proposal",            lane: "commercial", description: "bib emailed a sent proposal to the client — the PDF of record attached, with Accept and Decline buttons that open its link (0085). Recorded once the mail server took it. Payload: the email's id and the PDF's content hash — never the address, which is personal and lives in the erasable crm.proposal_email row." },
  "proposal.link_reissued":      { objectType: "proposal",            lane: "commercial", description: "A sent proposal was given a NEW link, and the old one stopped working (0085) — the firm lost the one shown at Send, or the client lost the email. Payload says whether bib emailed the new one." },
  "proposal.viewed":             { objectType: "proposal",            lane: "commercial", description: "The recipient opened the proposal from its share link. Recorded ONCE, on the first open; the running count lives on the row, because a client refreshing a page is not fifty facts about the business." },
  "proposal.accepted":           { objectType: "proposal",            lane: "commercial", description: "A proposal was accepted. Recorded by a colleague, or — with `via: \"share_link\"` in the payload and the system as actor — by the client on the link's page (0085), whose name, statement, address and browser are in the erasable crm.proposal_client_decision row. With `via: \"recorded\"` (0317), the client said yes OUTSIDE bib and a colleague holding acceptance:record recorded it: `channel` and `recordedAcceptanceId` in the payload, the name and the note in the erasable crm.recorded_acceptance row." },
  "proposal.rejected":           { objectType: "proposal",            lane: "commercial", description: "A proposal was declined by the recipient. As with an acceptance, `via: \"share_link\"` marks one the client gave on the link's page (0085)." },
  "proposal.expired":            { objectType: "proposal",            lane: "commercial", description: "A proposal passed its validity date. Written LAZILY — nothing here runs on a timer, so it is recorded the first time somebody tries to act on the proposal." },
  "engagement_letter.drafted":   { objectType: "engagement_letter",   lane: "commercial", description: "An engagement letter was drafted — the first row in the timeline of a document that will create obligations." },
  "engagement_letter.drafted_from_proposal": { objectType: "engagement_letter", lane: "commercial", description: "A letter was written up FROM an accepted quote, carrying its lines, prices and discounts across (T3.5b). Recorded beside `engagement_letter.drafted` and not instead of it: the draft is the same act either way, and this is the extra fact — that the terms were CARRIED rather than typed, and how many of the quote's lines did not make it. The payload counts; the descriptions that would say WHICH are the client's own words." },
  "engagement_letter.sent":      { objectType: "engagement_letter",   lane: "commercial", description: "An engagement letter went to the client for signature." },
  "engagement_letter.issuer_changed": { objectType: "engagement_letter", lane: "commercial", description: "A DRAFT letter was moved to another of the firm's own companies, or to another country, before it went out (T6.18 S6): who contracts, or under whose law, changed, and its wording was replaced with that company's standard set for that country. Payload: the two companies, the two countries, and how many lines edited for this client went with the old wording." },
  "engagement_letter.currency_changed": { objectType: "engagement_letter", lane: "commercial", description: "A DRAFT letter's currency, or its rate back to the firm's reporting currency, changed (T6.18 S6), the currency only while the draft priced nothing. Payload: the two currencies, the two rates and the rate's day." },
  "engagement_letter.signature_requested": { objectType: "engagement_letter", lane: "commercial", description: "An e-signature provider accepted an envelope for a sent letter and asked the client to sign it (0080). Payload: the provider and its envelope id — never the signer's name or address, which live in the erasable request row." },
  "engagement_letter.withdrawn": { objectType: "engagement_letter",   lane: "commercial", description: "An engagement letter was pulled before signature. A SIGNED one is never withdrawn — it is superseded by a new letter." },
  "engagement_letter.deleted":   { objectType: "engagement_letter",   lane: "commercial", description: "A draft letter made by mistake was deleted before it went out for signature (0086): off the list of letters, still readable by id, and final. Different from withdrawn, which is a letter the client has seen and the firm pulled. Payload: the reference and the party." },
  "engagement_letter.copied":    { objectType: "engagement_letter",   lane: "commercial", description: "A withdrawn letter was copied into a new draft (0316), recorded against the OLD one. The old letter does not change. Payload: the new draft's id and reference, and counts of the lines, fee sections, terms and prose copied, and of the terms that could not be." },
  "engagement_letter.signed":    { objectType: "engagement_letter",   lane: "commercial", description: "The client signed. The letter freezes at this moment (a trigger, migration 0017) and one engagement is created per line. With `via: \"recorded\"` and signatureMethod `recorded_acceptance` (0317), the client accepted OUTSIDE bib and a colleague recorded it with the client's email filed as evidence: `channel` and `recordedAcceptanceId` in the payload, the rest in crm.recorded_acceptance." },
  "engagement_letter.advance_recorded": { objectType: "engagement_letter", lane: "commercial", description: "The advance fee was recorded as received, which releases every engagement the letter created. Recorded by a person until payments (T3.5) can confirm it." },
  "engagement.ended":            { objectType: "engagement",          lane: "commercial", description: "An engagement was ended (V2.3): its last day of service is `endsOn`, its status moved to completed (or cancelled when the end fell before its work began), and its untouched upcoming filings for periods after that day were withdrawn in the same transaction. Payload: from, to, endsOn, effectiveFrom and the counts (filings withdrawn, kept, re-pointed; jobs still open for after the end). The REASON is prose about a client and stays on the engagement row." },
  "engagement.paused":           { objectType: "engagement",          lane: "commercial", description: "Running work was paused (V2.3): no new jobs and no new filings until it resumes; nothing already on the calendar or the board moved." },
  "engagement.resumed":          { objectType: "engagement",          lane: "commercial", description: "A paused engagement resumed (V2.3). Payload: resumedOn, the firm's day, from which recurring periods spawn again (one that ended inside the pause never does), and when it had been paused." },
  "engagement.billing_scheduled": { objectType: "engagement",        lane: "commercial", description: "An engagement's billing schedule was set or changed (0318): the first period billed and the date its invoice falls due. A fee group's engagements move together, one event each. Payload: `billingFrom`, `firstInvoiceOn`, and the previous two." },
  "billing_due.created":         { objectType: "billing_due",         lane: "commercial", description: "The billing sweep found a period whose bill date has come and wrote a bill due (0318). Not an invoice: no number is drawn until a person raises one. Payload: `partyId`, `engagementId` or `feeGroupId`, `periodStart`, `billOn`, `managerHow`." },
  "billing_due.invoiced":        { objectType: "billing_due",         lane: "commercial", description: "A person raised an invoice from bill dues, or linked one already raised (0318). One event per due. Payload: `invoiceId`, `invoiceLineId` (null when linked), `how` (`raised` or `linked`)." },
  "billing_due.skipped":         { objectType: "billing_due",         lane: "commercial", description: "A person decided a bill due will not be billed (0318). The reason is on the row and never here: it is prose about a client. Payload: `partyId`, `periodStart`." },
  "contract.activated":          { objectType: "engagement",          lane: "commercial", description: "An engagement's COMMERCIAL gates opened: the client signed, and the advance was recorded when the letter required one. THE spawn trigger the scheduler consumes (T2.4) — written by T2.3, which is the module that causes it. The fee gate is real rather than advisory: no advance, no event. Since G1.5 the payload carries `effectiveFrom`, the day the work actually begins, which is NOT always the day this is emitted — a letter signed in September can open engagements that begin in October. Consumers MUST schedule from that date and not from this event's timestamp; it is emitted at the commercial gate rather than held until the date because nothing in this service runs on a timer, and an engagement nobody was told about is worse than one scheduled early." },
  "invoice.raised":              { objectType: "invoice",             lane: "commercial", description: "An invoice was created and its number ALLOCATED from the entity's gapless series. Registered because the allocation is the audit-relevant moment, not the sending: a consecutive series is evidence, and 'which number went to which client, when, decided by whom' is the question an auditor asks about a gap. The number is in the payload for the same reason." },
  "invoice.issued":              { objectType: "invoice",             lane: "commercial", description: "An invoice was issued and its number frozen." },
  "invoice.cancelled":           { objectType: "invoice",             lane: "commercial", description: "An invoice was cancelled by credit note; the number is never reused." },
  "payment.recorded":            { objectType: "payment",             lane: "commercial", description: "A payment was received and applied." },
  "credit_note.issued":          { objectType: "credit_note",         lane: "commercial", description: "A credit note was issued against an invoice." },
  "invoice.registered":          { objectType: "invoice",             lane: "commercial", description: "The government e-invoice registry's identifier (IRN) was recorded against an invoice. Its honest limit: nothing in this product talks to the IRP, so this records an answer obtained elsewhere — the same shape as the advance-fee attestation. The real connector is T7.1." },
  "invoice_series.set":          { objectType: "invoice_series",      lane: "commercial", description: "The firm named what one of its entities' invoice numbers READ as. It changes future numbers only — every issued invoice keeps the number it was issued with, because the freeze trigger refuses to move one." },
  "dunning.decided":             { objectType: "invoice",             lane: "commercial", description: "A partner approved or rejected a TERMINAL dunning step — credit hold or legal action. Both outcomes are recorded: 'we considered legal action and decided against it' is a fact somebody wants three months later, and a rejection that vanished would leave the ladder looking as though it never got there. objectType is the invoice, because 'what happened to this receivable' is the timeline anybody reads." },
  "dunning.escalated":           { objectType: "invoice",             lane: "commercial", description: "A receivable moved up the dunning ladder." },
  "document.stored":             { objectType: "document",            lane: "commercial", description: "Bytes were stored — a new document, or a further version of one. The payload carries the content hash, size and media type and NEVER the filename or title, both of which routinely name a client ('Kaveri Foods PAN.pdf'); this log is append-only and has to stay erasable by row. `origin` says whether the product rendered it or a person supplied it, which is what decides whether it can ever be produced again." },
  "document.client_visibility_set": { objectType: "document",        lane: "commercial", description: "The firm shared one of a client's own documents with them through the portal, or stopped sharing it (T6.7). ITS OWN VERB rather than a flavour of `document.attached`: this is a DISCLOSURE decision — who outside the firm may read this file — and \"when did this become visible to the client\" is asked after something reached somebody it should not have. The payload carries the flag and the party it was shared with; never the title or filename, which routinely name a client's own affairs and this log cannot be erased." },
  "document.attached":           { objectType: "document",            lane: "commercial", description: "A document version was linked to an object." },
  "document.link_withdrawn":     { objectType: "document",            lane: "commercial", description: "A document was taken OFF something it was attached to (0302). The link row is kept, marked withdrawn, so this event and the row agree; the payload names the subject and the link's role, never the title or filename." },
  "brand_asset.set":             { objectType: "brand_asset",         lane: "commercial", description: "A logo, signature or letterhead was put in force for one of the firm's OWN entities. Keyed on the entity and not the firm, because a firm signing on two letterheads is G1.2's rule applied to paper — and the superseded asset stays readable, so a document issued last year still resolves the mark it was issued under." },

  // ── delivery lane (B) · configure → schedule → execute → verify ────────────
  "workflow_template.published": { objectType: "workflow_template",   lane: "delivery",   description: "A workflow template version was published; running jobs pin the version they started on." },
  "rule_pack.activated":         { objectType: "rule_pack",           lane: "delivery",   description: "A rule-pack version became active. Never written by an agent." },
  "job.spawned":                 { objectType: "job",                 lane: "delivery",   description: "The scheduler created a job from a trigger or a recurrence. The payload names every engagement in it and how it was cut, because a merged job's cause is several engagements and its source_ref is a derived group key that names no row. A period job's payload also carries periodStart, periodEnd and periodLabel: which month or quarter the checklist is for." },
  "job.scope_extended":          { objectType: "job",                 lane: "delivery",   description: "Work joined a job that was ALREADY OPEN — the second line of an engagement letter, whose advance arrived after the first. Its own verb rather than a second job.spawned, because 'why did this job gain a service on the 14th' is a question somebody asks and a spawn event cannot answer it. The payload carries only the engagements that actually joined." },
  "job.template_pinned":         { objectType: "job",                 lane: "delivery",   description: "A job resolved the firm's published process and PINNED the version it will walk. Recorded because everything the job does afterwards is explained by this one row: editing the process later never moves a job already walking it, and the version id is what answers 'which wording of it' a year later." },
  "job.started":                 { objectType: "job",                 lane: "delivery",   description: "A job's steps were written from its pinned template and the work began. One event, not one per step." },
  "job.step_advanced":           { objectType: "job",                 lane: "delivery",   description: "A job's step moved — set aside for a person, taken by an agent, or finished. The payload carries both sides and who was expected to do it." },
  "job.step_assigned":           { objectType: "job",                 lane: "delivery",   description: "A job's step was put on somebody's desk, or taken off it. `how` says whether the router chose at job start (`spoc`, `key_manager` or `partner`, the rung of the owner rule that named them), somebody took it, somebody handed it over, it was released, or it went `with_task` when the job's task was handed on — different answers to the later question of why this person did this step. User ids only." },
  "job.step_skipped":            { objectType: "job",                 lane: "delivery",   description: "A step will not happen: its condition did not hold (when it would have started, or after it had opened and before anybody recorded work on it, which the payload marks with afterStart, from and the assignee's id), or something it depends on was skipped. NOT the same as done, and recorded as loudly, because 'we did not do this and here is why' is the question asked when a filing is questioned. The payload carries the FACT and its values, never the prose note — a sentence does not GROUP BY." },
  "job.step_failed":             { objectType: "job",                 lane: "delivery",   description: "An agent could not complete a step. Terminal for the step; the job blocks, because a machine giving up is a thing a person then has to decide about." },
  "job.completed":               { objectType: "job",                 lane: "delivery",   description: "A job reached a terminal step." },
  "job.cancelled":               { objectType: "job",                 lane: "delivery",   description: "A person stopped a job for good (V2.4): its open steps were withdrawn (skipped, noted as cancelled) and its open tasks moved to the firm's own cancelled state. Payload: the status it was cancelled from, the withdrawn step keys and the counts. No prose: why it was cancelled is a person's sentence and this log cannot be erased." },
  "work_item.created":           { objectType: "work_item",           lane: "delivery",   description: "Work landed on the firm's board — spawned from an engagement, or raised by hand. `origin` says which, because \"where did this task come from\" is the first question asked about one nobody recognises. The TITLE is not in the payload: it is copied from a service name today and is prose the moment somebody edits it, and it routinely names a client." },
  "work_item.assigned":          { objectType: "work_item",           lane: "delivery",   description: "A work item was routed to a person, or taken off their desk. `how` distinguishes the ROUTER's answer (`spoc`, `key_manager` or `partner`, the rung of the owner rule that named them) from a human override (`manual`) — \"the Dept SPOC got it\", \"it came to the Key Manager to hand out\" and \"a partner moved it\" are different answers to the same later question, and nothing else in the row tells them apart." },
  "work_item.updated":           { objectType: "work_item",           lane: "delivery",   description: "A work item's due date, priority or client visibility was edited. Both sides of each change, because a MOVED DUE DATE is what answers \"why was this late\" — a payload saying only that something was edited could not. The title and description are prose about a client's work and stay off this log, which cannot be erased: THAT a title changed is recorded, what it changed to is not." },
  "work_item.state_changed":     { objectType: "work_item",           lane: "delivery",   description: "A work item moved between the firm's own states. Carries both state ids and the two FLAGS that changed what the row must hold (`isBlocked`, `isTerminal`) — the flags rather than the names, because the names are the firm's to rename. The block REASON is deliberately absent: it is prose a person wrote, it routinely names a colleague or a client, and this log cannot be erased." },
  "work_item.completed":         { objectType: "work_item",           lane: "delivery",   description: "A work item reached a state the firm has marked terminal. Its own verb beside `state_changed`, because \"what did we finish last month\" cannot be answered from a generic move without knowing which states were terminal at the time." },
  "work_item.escalated":         { objectType: "work_item",           lane: "delivery",   description: "A rung of the firm's escalation ladder was climbed on a task (T4.5) — it is past the SLA it was created with, or nobody has picked it up. Payload carries the rung's key, what it was watching, how many days past, and WHO it landed on: a person, a grade rank, or nobody with the reason. The reason is a sentence the product wrote about its own routing, never prose about a colleague, which is why it may be in a log that cannot be erased. Written per notice rather than per sweep: \"when did anybody first get told about this\" is asked about ONE task and a count cannot answer it." },
  "work_item.dependency_added":  { objectType: "work_item",           lane: "delivery",   description: "One work item was made to wait on another. objectType is the WAITING item, because that is whose timeline the delay belongs on." },
  "work_item.dependency_removed":{ objectType: "work_item",           lane: "delivery",   description: "A dependency was lifted. The row is deleted — it carries no history of its own — so this event is the only record that somebody removed the thing holding work back, which is the half worth keeping." },
  "work_item.review_requested":  { objectType: "work_item_approval",  lane: "delivery",   description: "A work item was sent to be checked. Carries the PINNED policy version, so a firm raising its review bar in April never restates what was allowed in March, and `hasMaker` — whether there is anybody for maker != checker to bite on at all." },
  "work_item.review_approved":   { objectType: "work_item_approval",  lane: "delivery",   description: "A checker approved a work item. Never the same person who did it — a CHECK constraint, not a UI rule. The reviewer's NOTE stays on the row: it is prose about a colleague's work and this log cannot be erased." },
  "work_item.review_rejected":   { objectType: "work_item_approval",  lane: "delivery",   description: "A checker sent a work item back. Recorded as loudly as an approval, because marking the task Completed later erases the fact that it was rejected at all — and how often work comes back is the only honest measure of whether the process is working." },
  "work_item_state.created":     { objectType: "work_item_state",     lane: "delivery",   description: "A firm added a state to its own work vocabulary. Logged because the FLAGS on it — starting, terminal, blocked — decide what every work item in that state must carry." },
  "work_item_state.updated":     { objectType: "work_item_state",     lane: "delivery",   description: "A work-item state was renamed, re-flagged, reordered or retired. The payload carries both sides of whatever changed: \"it stopped being terminal on the 4th\" is what explains a board that suddenly reads differently. Never a delete — items sitting in a retired state keep it." },
  "work_item_priority.created":  { objectType: "work_item_priority",  lane: "delivery",   description: "A firm added a priority to its own work vocabulary." },
  "work_item_priority.updated":  { objectType: "work_item_priority",  lane: "delivery",   description: "A priority was renamed, re-ranked, or made the default for ordinary or for STATUTORY work. The statutory default is the firm's rule \"statutory due dates are high priority anyway\" made mechanical, so moving it changes the urgency of every filing created afterwards — which is exactly why who moved it is the record." },
  "work_vocabulary.seeded":      { objectType: "tenant",              lane: "delivery",   description: "A new tenant's work-item states and priorities were initialised from the product defaults. One event, not twelve. The names are the previous vendor's vocabulary and are unconfirmed — which costs nothing, because they are rows and renaming one is an UPDATE." },
  "obligation_rule.created":     { objectType: "obligation_template", lane: "delivery",   description: "A compliance rule was written — what the law asks of an entity, and when. Recorded because a due date is a RULE: a wrong one costs the client a penalty, so who added it and under which rule pack has to survive. Written in the catalogue FOR a service (T6.16), it also carries `services` and `spawned`, the filings it put on that service's clients' calendar in the same act; each service then has its own `obligation_rule.linked` with `onCreate`." },
  "obligation_rule.updated":     { objectType: "obligation_template", lane: "delivery",   description: "A compliance rule was edited, confirmed against the statute, or retired. `status` moving to confirmed is the important one — it is a partner taking responsibility for a date that until then came from a document rather than from the firm." },
  "obligation_rule.exception_added":   { objectType: "obligation_template", lane: "delivery", description: "A rule gained an exception for one period — March's TDS deposit being due 30 April rather than 7 April. Payload carries the period month and the replacement due rule, never the note: the prose is on the row, and this log cannot be erased." },
  "obligation_rule.exception_removed": { objectType: "obligation_template", lane: "delivery", description: "An exception was withdrawn, so the rule's own formula governs that period again. Recorded separately from an edit because it changes a date somebody may already have filed against." },
  "obligation_rule.superseded":  { objectType: "obligation_template", lane: "delivery",   description: "The LAW changed from a day, so a rule handed over to a successor. Not an edit and not a retirement: the old row goes on governing every period before the cutover and goes on explaining the filings made under it, while the new one governs from that day and takes over the unstarted filings already on the calendar for its periods (0303). The payload carries the cutover, both rule packs, both formulas, and COUNTS of the rows handed over, re-dated and kept on the old rule because somebody had started them, because \"which rule was this return due under\" is the question an audit asks and the answer moved on a date." },
  "obligation_rule.linked":      { objectType: "obligation_template", lane: "delivery",   description: "A compliance filing was added to a catalogue service (T6.16, 0309), so that service's clients owe it. The object is the rule's CHAIN (its first rule's id), because the link is on the chain and survives the law changing. Payload carries the chain, the rule in force, the service (its key and, since the T6.16 follow-up, its `serviceName` as it read at the write, so the audit trail can name it; absent on events written before), whether adding it CONFIRMED an unconfirmed rule in the same act, and COUNTS of the filings it put on the calendar (`spawned`) and brought back (`restored`). When the link is made in the same act as writing the rule, `onCreate` is true and the counts are on `obligation_rule.created`. The rule's name travels, as on every rule verb; nothing a person typed about a client does." },
  "obligation_rule.unlinked":    { objectType: "obligation_template", lane: "delivery",   description: "A compliance filing was removed from a catalogue service (T6.16). Removing it WITHDRAWS that service's untouched upcoming filings for clients no other linked service still covers: kept on their rows and marked, never deleted. Payload names the service (`serviceKey`, and `serviceName` as it read at the write since the T6.16 follow-up; absent on events written before) and carries COUNTS: `withdrawn`, and what was kept and why (`keptStarted`, `keptPastDue`, `keptCoveredElsewhere`), because a partial change reported as a whole one is how a deadline moves without anybody being told. Counts rather than a verb per row, the arrangement a supersession's handover and a restate already have: which filings came off is on each row (`withdrawn_at`, `withdrawn_by_user_id`, `withdrawn_reason`), and a list of ids in a log nobody can erase would outlive the rows it names." },
  "obligation_rules.seeded":     { objectType: "tenant",              lane: "delivery",   description: "A firm was given the shipped India rule pack. Payload carries how many rules produce dates and how many are waiting on a fact the firm has not given — the second number is the honest state of the firm's own specification, not a failure." },
  "obligation_state.created":    { objectType: "obligation_state",    lane: "delivery",   description: "A firm added a state to its own compliance vocabulary. Logged because the FLAGS decide mechanism rather than appearance: which state a generated filing starts in, which one a completed filing lands in, and which one a passed deadline moves to. A row added with the wrong flag is a rule changed." },
  "obligation_state.updated":    { objectType: "obligation_state",    lane: "delivery",   description: "A compliance state was renamed, re-flagged, reordered or retired. The payload carries both sides of whatever changed, and here that is not a nicety: \"it stopped being the missed state on the 4th\" is the only thing that explains a decision queue which silently stopped filling. Never a delete — obligations sitting in a retired state keep it." },
  "obligation_resolution_option.created": { objectType: "obligation_resolution_option", lane: "delivery", description: "A firm added an answer to its list of what may be decided about a passed deadline. `closesWithoutFiling` is the fork it carries: false sends the obligation back to be filed late, true ends it unfiled." },
  "obligation_resolution_option.updated": { objectType: "obligation_resolution_option", lane: "delivery", description: "A resolution option was renamed, re-pointed, confirmed, reordered or retired. Confirming one matters on its own: the four shipped options came from a previous vendor's app and seed `unconfirmed`, so this is the firm saying the list is actually theirs. Decisions already recorded against a retired option are untouched." },
  "obligation_vocabulary.seeded":{ objectType: "tenant",              lane: "delivery",   description: "A new tenant's obligation states were initialised from the product defaults. One event, not five, the same as `work_vocabulary.seeded`." },
  "obligation.spawned":          { objectType: "obligation_instance", lane: "delivery",   description: "A statutory or internal obligation instance was created for a period. Written per instance rather than per sweep, because \"when did we first know this client owed this filing?\" is asked about ONE filing and a batch count cannot answer it." },
  "obligation.restored":         { objectType: "obligation_instance", lane: "delivery",   description: "A filing that had been taken off the calendar when a service stopped including it came back, because a linked service proposed its period again (T6.16): the filing was added back to the service, or the client took another service that owes it. Written by the GENERATOR per row, exactly like `obligation.spawned`, and for the same reason: \"when was this filing back on the calendar\" is asked about ONE filing. Same row, same id, so anything that already named it still does. Payload carries the rule and the dates it now holds (from `scheduleFor`), and `withdrawnAt`, the instant it had been taken off, because restoring clears that column and the ledger is then the only place the withdrawal is remembered." },
  "obligation.work_raised":      { objectType: "obligation_instance", lane: "delivery",   description: "An obligation reached its internal target (T-X) and became a task on somebody's desk. The one place the calendar and the work board are joined, so it is the one place that join is recorded." },
  "obligation.filed":            { objectType: "obligation_instance", lane: "delivery",   description: "An obligation was discharged (filed / paid / submitted). Written when the work item raised for it reaches a state the firm marks both terminal AND successful — a cancelled task is not a filing, and `is_terminal` alone would have said it was." },
  "obligation.filing_reversed":  { objectType: "obligation_instance", lane: "delivery",   description: "A filing already recorded was taken back, because the work item that discharged it was reopened or cancelled. Its own verb rather than a silent UPDATE: `filed_on` is a claim about a statutory date, and a claim that is withdrawn is exactly the kind of thing somebody asks about afterwards." },
  "obligation.missed":           { objectType: "obligation_instance", lane: "delivery",   description: "A statutory date passed undischarged, and the nightly sweep moved the obligation to the state the firm flagged `is_missed` — where a partner has to choose what happens about it. A STATE, NOT AN ERROR: the system does not hide it and does not retry it. Written per instance rather than per sweep, because \"when did this filing go late\" is asked about one filing and a count cannot answer it. Carries `daysLate` (positive; the sweep only ever runs after the date) so the queue can be read without recomputing it. Not written for anything already filed, already decided about, or falling before the firm's published `compliance_policy` floor." },
  "obligation.resolved":         { objectType: "obligation_instance", lane: "delivery",   description: "A partner decided what happens about a deadline already missed — file it provisionally, accept the late fee, file a nil return, or record that it never applied. In a CA firm this is where money and liability are settled, and before this it happened on WhatsApp and was written down nowhere. THE PAYLOAD CARRIES THE OPTION AND NEVER THE REASON: the option is a code the firm defined and can be counted; the reason is a partner's free text about a client and may name a person, so it lives in the erasable row (§3.4). `closesWithoutFiling` says which fork was taken — false sends the obligation back to work and 0054 files it late when that work finishes, true ends it in the firm's resolution state and it will never be filed." },
  "obligation.nudged":           { objectType: "obligation_instance", lane: "delivery",   description: "The firm told a client that one of their filings is coming up (T6.7) — a rung of the PROACTIVE ladder, counting down to the statutory date. WRITTEN PER RUNG and only when the row was actually created, like `client_ask.chased`, so \"we told you a week out and again the day before\" is supported by the rows. Deliberately not `client_ask.chased`: a chase is about something the firm ASKED FOR and has not had back, a nudge asks for nothing and names a date the LAW set — and one is stopped by a client freeze while the other is not (0067). The actor is the SYSTEM: a cron sent it. Payload carries the rung key, the threshold it fired at, how many days were left and the date it named; never the template name, which is prose about a client's own affairs." },
  "obligation.escalated":        { objectType: "obligation_instance", lane: "delivery",   description: "A filing passed the firm's OWN internal target (T-X) with the statutory date still ahead, and the escalation ladder told somebody (T4.5). Deliberately not `obligation.missed`, which is the statutory date going by and the client's money already gone: this is the warning that exists so that never happens, and collapsing the two would lose the only distinction that makes the earlier one worth having. Same payload shape as `work_item.escalated`." },
  "client_ask.raised":           { objectType: "client_ask",           lane: "delivery",   description: "The firm asked one of a client's own people for something, on a named task (T6.6). Its own verb rather than a work-item edit, because \"when did we first ask, and how many times\" is the question behind every late filing a firm blames on its client — and until this row existed the only trace was `blocked_reason`, a sentence that reads the same whether the firm is waiting on the client or on a government portal. THE PROMPT IS NOT IN THE PAYLOAD: it is prose about a client's own business and this log cannot be erased. `askKind` is, because whether a firm asks for documents or for decisions is a fact about the firm." },
  "client_ask.answered":         { objectType: "client_ask",           lane: "delivery",   description: "A client's own contact responded — a file, an answer in words, or a decision. WRITTEN PER RESPONSE, not per ask: \"they sent the wrong register on the 3rd and the right one on the 9th\" is two facts, and an ask that only recorded its first answer would credit the client with a week they did not have. The payload carries the response KIND and, for a decision, which way it went; never the words, which are the client's own text about their own affairs. The actor is the CLIENT CONTACT — the first verb in this registry whose human actor is routinely somebody outside the firm." },
  "client_ask.closed":           { objectType: "client_ask",           lane: "delivery",   description: "The firm accepted what came back and the ask is finished. Separate from `answered` deliberately: the client responding does not close an ask, because a client who sent last quarter's register would otherwise see it marked done and the firm would have to raise a second one that reads as a fresh request. This event is the firm saying that was it." },
  "client_ask.withdrawn":        { objectType: "client_ask",           lane: "delivery",   description: "The firm no longer needs what it asked for — it found the document itself, or the work moved on. Its own verb rather than a flavour of `closed`, because \"you sent it\" and \"never mind\" are different answers to a client asking whether they actually had to do that, and because a firm counting how often it withdraws its own asks is measuring something real about how it asks." },
  "client_ask.chased":           { objectType: "client_ask",           lane: "delivery",   description: "A rung of the firm's OUTWARD ladder was climbed on an ask a client has not answered (T4.4). WRITTEN PER RUNG, not per sweep, and only when the row was actually created — so \"we reminded you four times\" is a sentence the count supports rather than one somebody estimates. The actor is the SYSTEM and that is honest: nobody at the firm decided to send this one, a cron did. Payload carries the rung key, the threshold it fired at and how long the ask had been open; never the prompt, which is prose about a client's business." },
  "client_request.raised":       { objectType: "client_request",       lane: "delivery",   description: "A client asked the FIRM for something, unprompted (T6.8). The first verb in this registry whose human actor is outside the firm and is STARTING something rather than replying to one of its asks — `client_ask.answered` was outside-the-firm but always an answer. Its own object because a client's request hangs off nothing: it has no work item and may never get one, which is exactly why it could not be a `client_ask` with the arrow reversed (0068). Payload carries the company only. NEITHER THE SUBJECT NOR THE BODY: both are the client's own words about their own affairs — \"we are being assessed for FY23, send the returns\" names their business as readily as a filename does — and this log cannot be erased." },
  "client_request.replied":      { objectType: "client_request",       lane: "delivery",   description: "Somebody added to the thread on a client's request. WRITTEN PER REPLY and by BOTH SIDES, with `authorSide` in the payload saying which — one verb rather than two, because \"who said what, when\" on one request is one sequence and splitting it across two verbs would have every reader merging them by timestamp. `documentAttached` records that the firm sent a file back, which is a fact about what the firm DID; the file's own name is not here, and neither side's words are. Note what attaching does elsewhere: it flips `files.document.is_client_visible` in the same transaction, because sending a document to a client IS the decision to show it to them (0066, 0068)." },
  "client_request.assigned":     { objectType: "client_request",       lane: "delivery",   description: "A client's request was put on somebody's desk (T6.8, migration 0070). `by` says WHETHER A PERSON OR THE RULE decided, and that half is the whole point: it is the only way to answer \"is this routing rule actually finding anybody\" six months later, and it is a fact about the firm rather than about a client. WRITTEN PER PLACEMENT, including the one the rule makes at the moment a request arrives — so the count is rows rather than an estimate, the arrangement `client_ask.chased` and `obligation.nudged` both take. When the rule places it the actor is the CLIENT CONTACT whose request caused it, honestly: naming the assignee would credit them with a decision they did not take, and naming the SYSTEM would hide that somebody outside the firm set it off. A request taken OFF a desk is this verb with a null assignee." },
  "client_request.routing_set":  { objectType: "tenant",               lane: "delivery",   description: "The firm changed how an arriving client request is routed — `none` or `key_manager` (migration 0070). The OBJECT IS THE FIRM, because this is a fact about the firm and not about any request, the same shape the work-split setting takes. It RESTATES NOTHING: requests already on a desk keep their assignee and the next one is routed the new way, so this event is the only record that the rule changed under work already in flight. A SPOC is not among the values and cannot be without an axis — a request names no service." },
  "client_request.closed":       { objectType: "client_request",       lane: "delivery",   description: "THE FIRM is done with a client's request. Separate from `withdrawn` and the split is the point: this one is written by somebody at the firm and that one by somebody at the client, which is why 0068 calls the columns `settled_by`/`settled_at` rather than borrowing `client_ask`'s `closed_by`. The firm replying does NOT close a request — a client sent the wrong year's balance sheet has to be able to say so — so this event is the firm saying that was it. Payload carries how many replies the thread ran to, which is the only number anybody asks about an inbox with no routing." },
  "client_request.withdrawn":    { objectType: "client_request",       lane: "delivery",   description: "THE CLIENT no longer wants what they asked for — they sorted it themselves, or it stopped mattering. Never written by the firm: \"we decided you did not need this\" is a refusal, and a refusal is a `closed` with a reply saying so. Its own verb for `client_ask.withdrawn`'s reason pointed the other way — a firm whose client requests are mostly withdrawn is being told something real about how fast it answers." },
  "client_freeze.set":           { objectType: "client_freeze",        lane: "delivery",   description: "A partner stopped the chaser on one client (T4.4) — typically a dispute somebody is negotiating. THE REASON IS DELIBERATELY NOT IN THE PAYLOAD: it is a partner's free text about a client, it may name a person, and this log cannot be erased; it lives on the row, which can be. Same split as `obligation.resolved`. It stops the OUTWARD ladder only — the firm goes on hearing about its own late work, because a dispute is the worst possible moment to go blind to that." },
  "client_freeze.lifted":        { objectType: "client_freeze",        lane: "delivery",   description: "Chasing resumed for a client. NOT a delete: the row stays, which is what makes \"was this client being chased in March\" answerable a year later. The payload carries the FIRST DAY NOT IN FORCE, because a half-open bound is the half people get wrong." },
  "agent_run.completed":         { objectType: "agent_run",         lane: "delivery",   description: "An agent produced an output, with its confidence score in the payload." },
  "agent_run.escalated":         { objectType: "agent_run",           lane: "delivery",   description: "An agent refused to act and handed the work to a human. Its output is kept and offered as material, not as an answer." },
  "agent_run.decided":           { objectType: "agent_run",           lane: "delivery",   description: "A person accepted, corrected or rejected what a machine proposed. The payload carries WHICH of the three and never the values — accepted vs corrected is the entire accuracy signal, and an agent's output can hold a client's own data, which may not enter a log that cannot be erased." },
  "output.approved":             { objectType: "verification",        lane: "delivery",   description: "A checker approved an output. Never the same actor that produced it." },
  "output.rejected":             { objectType: "verification",        lane: "delivery",   description: "A checker rejected an output and sent it back." },
} as const satisfies Record<string, VerbSpec>;

export type EventVerb = keyof typeof EVENT_VERBS;

export function isEventVerb(v: string): v is EventVerb {
  return Object.prototype.hasOwnProperty.call(EVENT_VERBS, v);
}

/** The object type a verb names. Callers never pass one, so a verb and its
 *  object can never disagree. */
export function objectTypeFor(verb: EventVerb): string {
  return EVENT_VERBS[verb].objectType;
}

/** Registered verbs sharing a prefix — used to make "unknown verb" errors name
 *  the near misses instead of dumping the whole registry. */
export function verbsWithPrefix(prefix: string): readonly string[] {
  return Object.keys(EVENT_VERBS).filter((v) => v.startsWith(`${prefix}.`));
}

/** The naming convention every registry key must satisfy: lowercase snake_case
 *  segments, exactly two, separated by a dot. Asserted over the registry by a
 *  unit test, so a malformed verb cannot be added. */
export function isWellFormedVerb(v: string): boolean {
  return /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(v);
}

// ── Pure rules ───────────────────────────────────────────────────────────────

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** An actor is well formed when a human or agent names itself and only the
 *  platform is anonymous. Mirrors the event_actor_identified_chk constraint. */
export function isIdentifiedActor(actor: Actor): boolean {
  if (actor.type === "system") return actor.id === null;
  return actor.id !== null && isUuid(actor.id);
}

/** Timestamps on the wire are ISO 8601 with an explicit offset — a bare local
 *  time has no meaning across the jurisdictions this product serves. */
export function isIsoTimestamp(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

/**
 * Payload keys that carry personal data. The log is append-only and therefore
 * un-erasable, so these must live in a normal row and be referenced by id:
 * write `{ partyId }`, never `{ email }`; write `{ identifierId }`, never
 * `{ pan }`. The set is deliberately about IDENTIFYING A PERSON — a company's
 * legal_name or GSTIN is a business fact and stays allowed.
 */
const PII_KEYS: ReadonlySet<string> = new Set([
  "email", "email_address", "personal_email",
  "phone", "phone_number", "mobile", "mobile_number", "whatsapp",
  "aadhaar", "aadhar", "uidai", "ssn", "nric", "passport", "passport_number",
  "pan", "din", "date_of_birth", "dob", "birth_date",
  "full_name", "first_name", "last_name", "middle_name", "father_name", "maiden_name",
  "address", "residential_address", "street", "postal_code", "zip",
  "bank_account", "account_number", "account_no", "iban", "ifsc", "card_number",
  "password", "password_hash", "otp", "token", "secret", "api_key", "signature_image",
]);

/** camelCase / kebab-case / spaced keys all normalise to snake_case, so the
 *  denylist cannot be side-stepped by spelling. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

/** A payload is a flat set of machine facts; this is the ceiling below which
 *  the personal-data scan is exhaustive. */
export const MAX_PAYLOAD_DEPTH = 8;

/**
 * The path of the first personal-data key found in a payload, or null. Walks
 * nested objects and arrays: burying an email one level down is the same leak.
 * Beyond MAX_PAYLOAD_DEPTH it stops looking — a payload that deep is not the
 * flat set of machine facts this log is for, and is rejected on those grounds
 * by `isPayloadTooDeep`.
 */
export function findPiiKey(payload: unknown, path = ""): string | null {
  return walk(payload, path, 0);
}

function walk(value: unknown, path: string, depth: number): string | null {
  if (depth > MAX_PAYLOAD_DEPTH || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = walk(item, `${path}[${String(i)}]`, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (PII_KEYS.has(normalizeKey(key))) return here;
    const hit = walk(child, here, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

export function isPayloadTooDeep(payload: unknown): boolean {
  return depthOf(payload, 0) > MAX_PAYLOAD_DEPTH;
}

function depthOf(value: unknown, depth: number): number {
  if (depth > MAX_PAYLOAD_DEPTH || value === null || typeof value !== "object") return depth;
  let deepest = depth;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepest = Math.max(deepest, depthOf(child, depth + 1));
    if (deepest > MAX_PAYLOAD_DEPTH) return deepest;
  }
  return deepest;
}

/** A payload is a summary, not a document store: 64 KiB is generous for ids and
 *  machine facts and small enough that the log stays scannable at volume. Large
 *  artefacts belong in documents (P8), referenced by id. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Serialised size, or null if the value cannot be serialised at all (a cycle,
 *  a BigInt). Both are caller bugs and are reported as such. */
export function payloadByteLength(payload: Record<string, unknown>): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
  } catch {
    return null;
  }
}

/**
 * The idempotency namespace for derived event ids (platform/ids.ts `derivedId`).
 * A retried webhook or a racing pod that passes the same idempotency key derives
 * the SAME uuid and re-lands on the existing row instead of double-recording.
 *
 * This constant is part of the on-disk contract: if another service or language
 * ever derives event ids, it MUST use these exact bytes. Changing it silently
 * breaks deduplication against every event already written.
 */
export const EVENT_ID_NAMESPACE = "4f7d2a1e-9b3c-5d6e-8a0f-1c2b3d4e5f60";
