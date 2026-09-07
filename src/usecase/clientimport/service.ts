// Loading a firm's existing book — the use case.
//
// Two acts, two requests, one staged row between them:
//
//   STAGE    read the sheets, check every row against what the firm already
//            has, store the rows and the verdict, and say what confirming
//            would do. Nothing else is written.
//   CONFIRM  check again — the firm's records may have moved since — then
//            walk the plan through the party, assignment and engagement
//            services, one row at a time, and record what each became.
//
// ── EVERYTHING GOES THROUGH THE SAME DOORS AS THE SCREENS ──────────────────
//
// `createOrganization`, `registerLegalEntity`, `assign`, `draft` … `sign` —
// the same methods the forms call, so a client created here is
// indistinguishable from one typed in: same events, same triggers, same
// calendar. In particular a migrated engagement is a real signed letter,
// because in this schema an engagement cannot exist without one; the paper
// letter's whereabouts go in the signature's reference, and the attestation
// is dated today — which is when it happened.
//
// ── ONE ROW AT A TIME, AND THE HONEST LIMIT ────────────────────────────────
//
// Each service call commits on its own, so a confirm is NOT one transaction.
// A row that fails halfway is reported as such — the company created, the
// letter not — and the sheet can be uploaded again: a client on file is
// skipped, an engagement in force is skipped, and only what is missing is
// attempted. The second run is boring by design, which is what makes a
// partial first run recoverable rather than a mess.

import type { Actor } from "../../domain/ledger/model";
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { EventSink } from "../ledger/ports";
import {
  CLIENT_SHEET_MARKER,
  ENGAGEMENT_SHEET_MARKER,
  PEOPLE_SHEET_MARKER,
  RELATIONSHIP_WORDS,
  clientRowsOf,
  engagementRowsOf,
  mayConfirm,
  normaliseName,
  parseSheetDate,
  personRowsOf,
  rowsOf,
  validateImport,
  type ClientRow,
  type ImportReport,
  type ImportRows,
  type ImportSnapshot,
  type IsoDate,
  type KnownAxis,
  type KnownOrganization,
  type LetterPlan,
} from "../../domain/clientimport/model";
import {
  ClientImportAlreadyConfirmed,
  ClientImportBlocked,
  ClientImportNotFound,
  ClientSheetRequired,
  SheetEmpty,
  SheetHeaderMissing,
} from "../../domain/clientimport/errors";
import { clauseApplies } from "../../domain/engagement/model";
import { normalizeIdentifier } from "../../domain/party/model";
import type {
  AssignmentWriter,
  ClauseOnFile,
  ClientImportStore,
  ImportDirectory,
  ImportOutcome,
  LetterOutcome,
  LetterWriter,
  OutcomeRow,
  PartyWriter,
  SheetReader,
  StagedImport,
  StagedImportSummary,
} from "./ports";

/**
 * How far back the compliance calendar generates, in days — a MIRROR of the
 * calendar's own `REACH_BACK_DAYS`, held here so the import can warn about a
 * firm with no go-live floor without depending on the obligation use case.
 * `tests/clientimport/service.test.ts` asserts the two agree.
 */
export const CALENDAR_REACH_BACK_DAYS = 90;

export interface Deps {
  readonly store: ClientImportStore;
  readonly sheets: SheetReader;
  readonly directory: ImportDirectory;
  readonly parties: PartyWriter;
  readonly assignments: AssignmentWriter;
  readonly letters: LetterWriter;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

export interface UploadedSheet {
  readonly bytes: Uint8Array;
  readonly filename: string;
}

export interface StageInput {
  readonly tenantId: string;
  readonly stagedBy: string;
  readonly clients: UploadedSheet | null;
  readonly people: UploadedSheet | null;
  readonly engagements: UploadedSheet | null;
}

export interface ConfirmInput {
  readonly tenantId: string;
  readonly importId: string;
  readonly confirmedBy: string;
}

export class ClientImportService {
  constructor(private readonly deps: Deps) {}

  async stage(input: StageInput, actor: Actor): Promise<StagedImport> {
    if (input.clients === null) throw new ClientSheetRequired();
    const rows = this.parse({ ...input, clients: input.clients });
    const snapshot = await this.snapshot(input.tenantId, rows);
    const report = validateImport(rows, snapshot);

    const staged = await this.deps.store.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      fileNames: {
        clients: input.clients.filename,
        people: input.people?.filename ?? null,
        engagements: input.engagements?.filename ?? null,
      },
      rows,
      report,
      stagedBy: input.stagedBy,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_import.staged",
      objectId: staged.id,
      actor,
      // Counts only. The sheet carries names, emails and registration
      // numbers, and this log cannot be erased.
      payload: {
        clientRows: rows.clients.length,
        peopleRows: rows.people.length,
        engagementRows: rows.engagements.length,
        blocking: report.blocking,
        warnings: report.warnings,
        wouldCreate: report.counts,
      },
    });
    return staged;
  }

  async get(tenantId: string, importId: string): Promise<StagedImport> {
    const found = await this.deps.store.find(tenantId, importId);
    if (found === null) throw new ClientImportNotFound(importId);
    return found;
  }

  async list(tenantId: string): Promise<readonly StagedImportSummary[]> {
    return this.deps.store.list(tenantId);
  }

  async confirm(input: ConfirmInput, actor: Actor): Promise<StagedImport> {
    const staged = await this.get(input.tenantId, input.importId);
    if (staged.status === "confirmed") {
      throw new ClientImportAlreadyConfirmed(staged.id, staged.confirmedAt ?? "");
    }
    if (!mayConfirm(staged.report)) throw new ClientImportBlocked(staged.report.blocking, false);

    // The world may have moved since the sheet was checked — a client typed
    // in yesterday, a service retired this morning. The plan executed is the
    // one that holds NOW, and a sheet that no longer loads cleanly is sent
    // back rather than half-applied.
    const snapshot = await this.snapshot(input.tenantId, staged.rows);
    const report = validateImport(staged.rows, snapshot);
    if (!mayConfirm(report)) throw new ClientImportBlocked(report.blocking, true);

    const outcome = await this.execute(input.tenantId, staged.rows, report, snapshot, actor);
    const confirmed = await this.deps.store.confirm(
      input.tenantId,
      staged.id,
      outcome,
      input.confirmedBy,
      this.deps.clock.now().toISOString(),
    );

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_import.confirmed",
      objectId: staged.id,
      actor,
      payload: { created: outcome.created, skipped: outcome.skipped, failed: outcome.failed },
    });
    return confirmed;
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  private parse(input: StageInput & { readonly clients: UploadedSheet }): ImportRows {
    const sheet = (file: UploadedSheet, marker: string) => {
      const grid = this.deps.sheets.grid(file.bytes, file.filename);
      const rows = rowsOf(grid, marker);
      if (rows === null) throw new SheetHeaderMissing(file.filename, marker);
      if (rows.length === 0) throw new SheetEmpty(file.filename);
      return rows;
    };
    return {
      clients: clientRowsOf(sheet(input.clients, CLIENT_SHEET_MARKER)),
      people: input.people === null ? [] : personRowsOf(sheet(input.people, PEOPLE_SHEET_MARKER)),
      engagements:
        input.engagements === null
          ? []
          : engagementRowsOf(sheet(input.engagements, ENGAGEMENT_SHEET_MARKER)),
    };
  }

  // ── What the firm already has, in one read ──────────────────────────────

  private async snapshot(tenantId: string, rows: ImportRows): Promise<ImportSnapshot> {
    const today = this.today();
    const wantedIdentifiers = rows.clients.flatMap((c) =>
      c.identifiers.map((i) => ({ type: i.type, value: normalizeIdentifier(i.type, i.value) })),
    );
    const wantedEmails = rows.people.flatMap((p) =>
      p.email === null ? [] : [normalizeIdentifier("email", p.email)],
    );

    const [firm, services, axes, staff, relationshipTypes, clauses, organizations, holders, people, inForce, floor] =
      await Promise.all([
        this.deps.directory.firm(tenantId),
        this.deps.directory.liveServices(tenantId),
        this.deps.directory.axes(tenantId),
        this.deps.directory.activeStaff(tenantId),
        this.deps.directory.relationshipTypes(),
        this.deps.directory.clauses(tenantId),
        this.deps.directory.organizations(tenantId, today),
        this.deps.directory.identifierHolders(tenantId, wantedIdentifiers),
        this.deps.directory.peopleByEmail(tenantId, wantedEmails),
        this.deps.directory.engagementsInForce(tenantId, today),
        this.deps.directory.missedFromOn(tenantId),
      ]);

    const byPartyId = new Map<string, KnownOrganization>();
    const byName = new Map<string, KnownOrganization>();
    for (const o of organizations) {
      const known: KnownOrganization = {
        partyId: o.partyId,
        displayName: o.displayName,
        registered: o.registered,
        jurisdiction: o.jurisdiction,
        billToPartyId: o.parentPartyId ?? o.partyId,
        archived: o.archived,
      };
      byPartyId.set(o.partyId, known);
      for (const name of [o.legalName, o.tradeName ?? "", o.displayName]) {
        const k = normaliseName(name);
        if (k !== "" && !byName.has(k)) byName.set(k, known);
      }
    }
    const byIdentifier = new Map<string, KnownOrganization>();
    for (const h of holders) {
      const org = byPartyId.get(h.partyId);
      if (org) byIdentifier.set(`${h.type}:${h.value}`, org);
    }

    // The jurisdictions a letter could be written for, and whether the clause
    // library can cover each — computed for the countries this sheet and the
    // book actually name, since the set is otherwise unbounded.
    const candidates = new Set<string>();
    for (const c of rows.clients) if (c.jurisdiction !== null) candidates.add(c.jurisdiction.toUpperCase());
    for (const e of rows.engagements) if (e.where !== null) candidates.add(e.where.toUpperCase());
    for (const o of organizations) if (o.jurisdiction !== null) candidates.add(o.jurisdiction);
    const clauseJurisdictions = new Set<string>();
    for (const j of candidates) if (clausesFor(clauses, j).length > 0) clauseJurisdictions.add(j);

    return {
      today,
      firmCurrency: firm.reportingCurrency ?? "INR",
      services: new Map(services.map((s) => [normaliseName(s.code), s] as const)),
      axes,
      staff: new Map(staff.map((s) => [s.email.toLowerCase(), s.userId] as const)),
      relationshipTypes: new Set(relationshipTypes),
      clauseJurisdictions,
      byIdentifier,
      byName,
      peopleByEmail: new Map(people.map((p) => [p.email, { partyId: p.partyId, name: p.name }] as const)),
      activeEngagements: new Set(inForce.map((e) => `${e.entityPartyId}:${e.serviceId}`)),
      complianceFloor: floor,
      reachBackDays: CALENDAR_REACH_BACK_DAYS,
    };
  }

  // ── Doing it ────────────────────────────────────────────────────────────

  private async execute(
    tenantId: string,
    rows: ImportRows,
    report: ImportReport,
    snapshot: ImportSnapshot,
    actor: Actor,
  ): Promise<ImportOutcome> {
    const today = this.today();
    const firm = await this.deps.directory.firm(tenantId);
    const clauses = await this.deps.directory.clauses(tenantId);
    const outcomeRows: OutcomeRow[] = [];
    const letterOutcomes: LetterOutcome[] = [];
    const created = { clients: 0, entities: 0, people: 0, assignments: 0, letters: 0, engagements: 0 };
    let skipped = 0;
    let failed = 0;

    /** Client-sheet row → the party it is, created now or already on file. */
    const partyOfLine = new Map<number, string>();
    const verdictOf = (sheet: "clients" | "people" | "engagements", lineNo: number) =>
      report.rows.find((v) => v.sheet === sheet && v.lineNo === lineNo) ?? null;
    const activeDepts = snapshot.axes.filter((a) => a.axis === "dept" && a.isActive);
    const deptOf = (word: string): KnownAxis | null => {
      const w = normaliseName(word);
      return (
        activeDepts.find((a) => normaliseName(a.code) === w) ??
        activeDepts.find((a) => normaliseName(a.name) === w) ??
        null
      );
    };
    const earliestStart = (client: ClientRow): IsoDate | null => {
      const mine = report.letters
        .filter((l) => l.clientLineNo === client.lineNo)
        .map((l) => l.effectiveFrom)
        .sort();
      return mine[0] ?? null;
    };
    /** The party a sheet or on-file company name resolves to, now. */
    const partyOfName = (word: string): string | null => {
      const k = normaliseName(word);
      const onSheet = rows.clients.find((c) => normaliseName(c.legalName) === k);
      if (onSheet !== undefined) {
        const id = partyOfLine.get(onSheet.lineNo);
        if (id !== undefined) return id;
      }
      return snapshot.byName.get(k)?.partyId ?? null;
    };

    // ── Clients: groups before the companies under them ───────────────────
    const ordered = [...rows.clients.filter((c) => c.group === null), ...rows.clients.filter((c) => c.group !== null)];
    for (const row of ordered) {
      const verdict = verdictOf("clients", row.lineNo);
      if (verdict === null || verdict.action === "blocked") continue;
      if (verdict.action === "skip") {
        const onFile = snapshot.byName.get(normaliseName(row.legalName));
        const byId = row.identifiers
          .map((i) => snapshot.byIdentifier.get(`${i.type}:${normalizeIdentifier(i.type, i.value)}`))
          .find((o) => o !== undefined);
        const party = byId ?? onFile;
        if (party !== undefined) partyOfLine.set(row.lineNo, party.partyId);
        skipped += 1;
        outcomeRows.push({ sheet: "clients", lineNo: row.lineNo, name: row.legalName, action: "skipped", detail: verdict.detail, partyId: party?.partyId ?? null });
        continue;
      }

      let step = "creating the company";
      let partyId: string | null = null;
      const made: string[] = [];
      try {
        const org = await this.deps.parties.createOrganization(
          {
            tenantId,
            legalName: row.legalName.trim(),
            tradeName: row.tradeName ?? undefined,
            industry: row.industry ?? undefined,
            website: row.website ?? undefined,
          },
          actor,
        );
        partyId = org.partyId;
        partyOfLine.set(row.lineNo, org.partyId);
        made.push("the company");

        const incorporatedOn = row.incorporatedOn === null ? null : parseSheetDate(row.incorporatedOn);
        const clientSince = row.clientSince === null ? null : parseSheetDate(row.clientSince);

        if (row.jurisdiction !== null && row.entityType !== null) {
          step = "registering the legal entity";
          await this.deps.parties.registerLegalEntity(
            {
              tenantId,
              organizationPartyId: org.partyId,
              jurisdiction: row.jurisdiction.toUpperCase(),
              entityType: row.entityType.trim(),
              incorporatedOn: incorporatedOn ?? undefined,
              financialYearEnd: row.financialYearEnd ?? undefined,
              registeredAddress: row.registeredAddress === null ? undefined : { text: row.registeredAddress },
            },
            actor,
          );
          made.push(`its ${row.entityType.trim()} registration in ${row.jurisdiction.toUpperCase()}`);
        }

        for (const [i, id] of row.identifiers.entries()) {
          step = `adding its ${id.type.toUpperCase()}`;
          await this.deps.parties.addIdentifier(
            {
              tenantId,
              partyId: org.partyId,
              type: id.type,
              value: id.value,
              isPrimary: i === 0,
              validFrom: incorporatedOn ?? clientSince ?? today,
            },
            actor,
          );
        }
        if (row.identifiers.length > 0) {
          made.push(`${String(row.identifiers.length)} identifier${row.identifiers.length === 1 ? "" : "s"}`);
        }

        if (row.group !== null) {
          step = `filing it under "${row.group}"`;
          const parentId = partyOfName(row.group);
          if (parentId === null) throw new Error(`the group "${row.group}" was not created`);
          await this.deps.parties.addRelationship(
            { tenantId, fromPartyId: parentId, toPartyId: org.partyId, type: "parent_of", validFrom: incorporatedOn ?? clientSince ?? today },
            actor,
          );
          made.push(`its place under "${row.group}"`);
        } else if (firm.selfPartyId !== null) {
          step = "recording it as a client of the firm";
          await this.deps.parties.addRelationship(
            {
              tenantId,
              fromPartyId: org.partyId,
              toPartyId: firm.selfPartyId,
              type: "client_of",
              validFrom: clientSince ?? earliestStart(row) ?? today,
            },
            actor,
          );
        }

        if (row.keyManagerEmail !== null) {
          step = "naming the Key Manager";
          const userId = snapshot.staff.get(row.keyManagerEmail.toLowerCase());
          if (userId === undefined) throw new Error(`"${row.keyManagerEmail}" is no longer active staff`);
          await this.deps.assignments.assign(
            { tenantId, clientPartyId: org.partyId, role: "key_manager", userId, validFrom: clientSince ?? today },
            actor,
          );
          made.push("the Key Manager");
        }
        for (const [word, email] of Object.entries(row.spocEmails)) {
          const dept = deptOf(word);
          if (dept === null) continue;
          step = `naming the SPOC for ${dept.code}`;
          const userId = snapshot.staff.get(email.toLowerCase());
          if (userId === undefined) throw new Error(`"${email}" is no longer active staff`);
          await this.deps.assignments.assign(
            { tenantId, clientPartyId: org.partyId, role: "spoc", axisId: dept.id, userId, validFrom: clientSince ?? today },
            actor,
          );
          made.push(`the SPOC for ${dept.code}`);
        }

        // Counted only now: a row that failed halfway is reported as failed,
        // with what it did get done in its detail, and counted nowhere else —
        // "created 3, failed 1" over three rows is a sum nobody can read.
        created.clients += 1;
        if (row.jurisdiction !== null && row.entityType !== null) created.entities += 1;
        created.assignments += made.filter((m) => m === "the Key Manager" || m.startsWith("the SPOC for ")).length;
        outcomeRows.push({ sheet: "clients", lineNo: row.lineNo, name: row.legalName, action: "created", detail: made.join(", "), partyId });
      } catch (err) {
        failed += 1;
        outcomeRows.push({
          sheet: "clients",
          lineNo: row.lineNo,
          name: row.legalName,
          action: "failed",
          detail: `${step}: ${messageOf(err)}${made.length > 0 ? ` — already done: ${made.join(", ")}` : ""}`,
          partyId,
        });
      }
    }

    // ── People ────────────────────────────────────────────────────────────
    for (const p of rows.people) {
      const verdict = verdictOf("people", p.lineNo);
      if (verdict === null || verdict.action === "blocked") continue;
      if (verdict.action === "skip") {
        skipped += 1;
        outcomeRows.push({ sheet: "people", lineNo: p.lineNo, name: p.fullName, action: "skipped", detail: verdict.detail, partyId: null });
        continue;
      }
      const targetName = p.of ?? p.client;
      const targetId = partyOfName(targetName);
      if (targetId === null) {
        failed += 1;
        outcomeRows.push({ sheet: "people", lineNo: p.lineNo, name: p.fullName, action: "failed", detail: `"${targetName}" was not created, so the role has nothing to attach to`, partyId: null });
        continue;
      }
      let step = "creating the person";
      let partyId: string | null = null;
      try {
        const person = await this.deps.parties.createPerson({ tenantId, fullName: p.fullName.trim() }, actor);
        partyId = person.partyId;
        const since = (p.since === null ? null : parseSheetDate(p.since)) ?? today;
        if (p.email !== null) {
          step = "adding their email";
          await this.deps.parties.addIdentifier(
            { tenantId, partyId: person.partyId, type: "email", value: p.email, isPrimary: true, validFrom: since },
            actor,
          );
        }
        if (p.phone !== null) {
          step = "adding their phone";
          await this.deps.parties.addIdentifier(
            { tenantId, partyId: person.partyId, type: "phone", value: p.phone, validFrom: since },
            actor,
          );
        }
        step = "recording the role";
        const type = RELATIONSHIP_WORDS[normaliseName(p.relationship)] ?? p.relationship;
        await this.deps.parties.addRelationship(
          { tenantId, fromPartyId: person.partyId, toPartyId: targetId, type, validFrom: since },
          actor,
        );
        created.people += 1;
        outcomeRows.push({ sheet: "people", lineNo: p.lineNo, name: p.fullName, action: "created", detail: verdict.detail, partyId });
      } catch (err) {
        failed += 1;
        outcomeRows.push({ sheet: "people", lineNo: p.lineNo, name: p.fullName, action: "failed", detail: `${step}: ${messageOf(err)}`, partyId });
      }
    }

    // ── Letters — one per client per currency, each signed as it goes ─────
    for (const plan of report.letters) {
      const result = await this.writeLetter(tenantId, plan, partyOfLine, clauses, today, actor);
      letterOutcomes.push(result);
      if (result.action === "created") {
        created.letters += 1;
        created.engagements += result.engagementIds.length;
      } else {
        failed += 1;
      }
    }
    for (const e of rows.engagements) {
      const verdict = verdictOf("engagements", e.lineNo);
      if (verdict === null || verdict.action === "blocked") continue;
      if (verdict.action === "skip") {
        skipped += 1;
        outcomeRows.push({ sheet: "engagements", lineNo: e.lineNo, name: `${e.company} — ${e.serviceCode}`, action: "skipped", detail: verdict.detail, partyId: null });
        continue;
      }
      const letter = letterOutcomes.find((l) => l.lineNos.includes(e.lineNo));
      outcomeRows.push({
        sheet: "engagements",
        lineNo: e.lineNo,
        name: `${e.company} — ${e.serviceCode}`,
        action: letter?.action === "created" ? "created" : "failed",
        detail: letter?.action === "created" ? verdict.detail : (letter?.detail ?? "its letter was not written"),
        partyId: null,
      });
    }

    return { rows: outcomeRows, letters: letterOutcomes, created, skipped, failed };
  }

  private async writeLetter(
    tenantId: string,
    plan: LetterPlan,
    partyOfLine: ReadonlyMap<number, string>,
    clauses: readonly ClauseOnFile[],
    today: IsoDate,
    actor: Actor,
  ): Promise<LetterOutcome> {
    const lineNos = plan.lines.map((l) => l.engagementLineNo);
    const failed = (detail: string, letterId: string | null = null): LetterOutcome => ({
      clientName: plan.clientName,
      currency: plan.currency,
      action: "failed",
      detail,
      letterId,
      lineNos,
      engagementIds: [],
    });

    const clientPartyId =
      plan.clientPartyId ?? (plan.clientLineNo === null ? undefined : partyOfLine.get(plan.clientLineNo)) ?? null;
    if (clientPartyId === null) return failed(`"${plan.clientName}" was not created, so there is nobody to bill`);
    const entities = plan.lines.map((l) => ({
      line: l,
      partyId: l.entityPartyId ?? (l.entityLineNo === null ? undefined : partyOfLine.get(l.entityLineNo)) ?? null,
    }));
    const missing = entities.find((e) => e.partyId === null);
    if (missing !== undefined) return failed(`"${missing.line.entityName}" was not created, so its line has no entity`);

    const basis = [...new Set(plan.lines.map((l) => l.basis).filter((b): b is string => b !== null))];
    let step = "drafting the letter";
    let letterId: string | null = null;
    try {
      const letter = await this.deps.letters.draft(
        {
          tenantId,
          partyId: clientPartyId,
          jurisdiction: plan.jurisdiction,
          title: `${plan.clientName} — engagements on file`,
          currency: plan.currency,
          fxRate: "1",
          fxRateDate: plan.effectiveFrom,
          advanceRequired: false,
          background:
            `Recorded from the firm's own records on ${today}, for work already under way. ` +
            (basis.length > 0
              ? `The signed letter: ${basis.join("; ")}.`
              : "The signed paper letter is held by the firm."),
          issuedOn: plan.effectiveFrom,
          effectiveFrom: plan.effectiveFrom,
        },
        actor,
      );
      letterId = letter.id;

      for (const { line, partyId } of entities) {
        step = `adding the ${line.serviceCode} line for ${line.entityName}`;
        await this.deps.letters.addLine({
          tenantId,
          letterId: letter.id,
          entityPartyId: partyId ?? "",
          serviceVersionId: line.serviceVersionId,
          description: line.serviceName,
          quantity: "1",
          unitAmount: line.unitAmount ?? undefined,
          pricingNote: line.unitAmount === null ? "As per the paper letter — see the signature reference" : undefined,
          discountPercent: "0",
          effectiveFrom: line.startedOn,
          jurisdiction: line.jurisdiction ?? undefined,
          billingFrequency: line.billingFrequency,
        });
      }

      step = "attaching the firm's clauses";
      for (const versionId of clausesFor(clauses, plan.jurisdiction)) {
        await this.deps.letters.addClause(tenantId, letter.id, versionId);
      }

      step = "marking it sent";
      await this.deps.letters.send(tenantId, letter.id, actor);

      step = "recording the signature";
      const signed = await this.deps.letters.sign(
        {
          tenantId,
          letterId: letter.id,
          signedByName: plan.signatory,
          reference: `Migrated on ${today}${basis.length > 0 ? ` — ${basis.join("; ")}` : ""}`,
        },
        actor,
      );
      return {
        clientName: plan.clientName,
        currency: plan.currency,
        action: "created",
        detail: `${String(plan.lines.length)} line${plan.lines.length === 1 ? "" : "s"}, signed`,
        letterId: letter.id,
        lineNos,
        engagementIds: signed.engagements.map((e) => e.engagement.id),
      };
    } catch (err) {
      return failed(`${step}: ${messageOf(err)}${letterId === null ? "" : " — the draft is left for somebody to finish or withdraw"}`, letterId);
    }
  }

  private today(): IsoDate {
    return this.deps.clock.now().toISOString().slice(0, 10);
  }
}

/**
 * The clauses a migrated letter for `jurisdiction` may carry: those that
 * apply there, and whose governing law and courts — when they name one — name
 * that same country. A clause naming another country's law is refused by the
 * engagement service against the ISSUING entity, which the firm's preference
 * rows put in the letter's own country in the ordinary case; choosing only
 * matching terms here is what keeps the refusal from being met at confirm.
 */
export function clausesFor(clauses: readonly ClauseOnFile[], jurisdiction: string): readonly string[] {
  return clauses
    .filter(
      (c) =>
        clauseApplies(c.jurisdictions, jurisdiction) &&
        (c.governingLawJurisdiction === null || c.governingLawJurisdiction === jurisdiction) &&
        (c.courtsJurisdiction === null || c.courtsJurisdiction === jurisdiction),
    )
    .map((c) => c.versionId);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
