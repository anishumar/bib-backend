// In-memory fakes for the client import's ports.
//
// The directory fake is seeded with `with…()` calls; the three writer fakes
// RECORD every call in order and hand back sequential ids, so a test can
// assert exactly which doors the import walked through and in what order —
// which is the whole claim of the module. `failOn(step)` makes one writer
// throw, for the partial-run tests.

import type { Actor } from "../domain/ledger/model";
import type { IdentifierType } from "../domain/party/model";
import { MembershipExists } from "../domain/tenancy/errors";
import { PortalGrantDuplicate } from "../domain/portalaccess/errors";
import type { KnownAxis, KnownService } from "../domain/clientimport/model";
import type {
  AssignmentWriter,
  ClauseOnFile,
  ClientImportStore,
  EngagementInForce,
  FirmFacts,
  IdentifierHolder,
  ImportDirectory,
  ImportOutcome,
  ImportRates,
  LetterWriter,
  NewStagedImport,
  OrganizationOnFile,
  PartyWriter,
  PersonOnFile,
  PortalAccessGranter,
  PortalInviteWriter,
  PortalMemberFinder,
  SheetReader,
  StaffMember,
  StagedImport,
  StagedImportSummary,
} from "../usecase/clientimport/ports";

// ── The store ────────────────────────────────────────────────────────────────

export class FakeClientImportStore implements ClientImportStore {
  readonly rows: StagedImport[] = [];
  private readonly people = new Map<string, { name: string | null; email: string }>();

  withUser(userId: string, email: string, name: string | null = null): this {
    this.people.set(userId, { name, email });
    return this;
  }

  private person(userId: string): StagedImport["stagedBy"] {
    const p = this.people.get(userId) ?? { name: null, email: `${userId}@example.test` };
    return { userId, name: p.name, email: p.email };
  }

  create(row: NewStagedImport): Promise<StagedImport> {
    const staged: StagedImport = {
      id: row.id,
      tenantId: row.tenantId,
      status: "staged",
      fileNames: row.fileNames,
      rows: row.rows,
      report: row.report,
      outcome: null,
      stagedBy: this.person(row.stagedBy),
      stagedAt: "2026-09-07T09:00:00.000Z",
      confirmedBy: null,
      confirmedAt: null,
    };
    this.rows.push(staged);
    return Promise.resolve(staged);
  }

  find(tenantId: string, importId: string): Promise<StagedImport | null> {
    return Promise.resolve(this.rows.find((r) => r.tenantId === tenantId && r.id === importId) ?? null);
  }

  list(tenantId: string): Promise<readonly StagedImportSummary[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId)
        .map((r) => ({
          id: r.id,
          status: r.status,
          fileNames: r.fileNames,
          blocking: r.report.blocking,
          warnings: r.report.warnings,
          counts: r.report.counts,
          stagedBy: r.stagedBy,
          stagedAt: r.stagedAt,
          confirmedAt: r.confirmedAt,
        })),
    );
  }

  confirm(
    tenantId: string,
    importId: string,
    outcome: ImportOutcome,
    confirmedBy: string,
    confirmedAt: string,
  ): Promise<StagedImport> {
    const at = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === importId);
    const current = this.rows[at];
    if (current === undefined) throw new Error(`no staged import ${importId}`);
    const confirmed: StagedImport = {
      ...current,
      status: "confirmed",
      outcome,
      confirmedBy: this.person(confirmedBy),
      confirmedAt,
    };
    this.rows[at] = confirmed;
    return Promise.resolve(confirmed);
  }
}

// ── The sheet reader ─────────────────────────────────────────────────────────

/** Reads the bytes as a plain CSV — commas and newlines, no quoting — which is
 *  all a unit test needs. The real reader's quoting is its own test. */
export class FakeSheetReader implements SheetReader {
  grid(bytes: Uint8Array): (readonly string[])[] {
    return new TextDecoder().decode(bytes)
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => line.split(",").map((c) => c.trim()));
  }
}

export function sheetBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ── The directory ────────────────────────────────────────────────────────────

export class FakeImportDirectory implements ImportDirectory {
  private facts: FirmFacts = { selfPartyId: null, reportingCurrency: "INR" };
  private readonly services: KnownService[] = [];
  private readonly axisRows: KnownAxis[] = [];
  private readonly staff: StaffMember[] = [];
  private readonly types: string[] = ["director_of", "authorised_signatory_of", "shareholder_of", "parent_of", "employee_of", "client_of"];
  private readonly clauseRows: ClauseOnFile[] = [];
  private readonly orgs: OrganizationOnFile[] = [];
  private readonly holders: IdentifierHolder[] = [];
  private readonly peopleRows: PersonOnFile[] = [];
  private readonly inForce: EngagementInForce[] = [];
  private floor: string | null = null;

  withFirm(facts: FirmFacts): this {
    this.facts = facts;
    return this;
  }
  withService(s: KnownService): this {
    this.services.push(s);
    return this;
  }
  withAxis(a: KnownAxis): this {
    this.axisRows.push(a);
    return this;
  }
  withStaff(email: string, userId: string, name: string | null = null): this {
    this.staff.push({ email, userId, name });
    return this;
  }
  withClause(c: ClauseOnFile): this {
    this.clauseRows.push(c);
    return this;
  }
  withOrganization(o: OrganizationOnFile): this {
    this.orgs.push(o);
    return this;
  }
  withIdentifier(type: IdentifierType, value: string, partyId: string): this {
    this.holders.push({ type, value, partyId });
    return this;
  }
  withPerson(p: PersonOnFile): this {
    this.peopleRows.push(p);
    return this;
  }
  withEngagement(e: EngagementInForce): this {
    this.inForce.push(e);
    return this;
  }
  withComplianceFloor(day: string | null): this {
    this.floor = day;
    return this;
  }

  firm(): Promise<FirmFacts> {
    return Promise.resolve(this.facts);
  }
  liveServices(): Promise<readonly KnownService[]> {
    return Promise.resolve([...this.services]);
  }
  axes(): Promise<readonly KnownAxis[]> {
    return Promise.resolve([...this.axisRows]);
  }
  activeStaff(): Promise<readonly StaffMember[]> {
    return Promise.resolve([...this.staff]);
  }
  relationshipTypes(): Promise<readonly string[]> {
    return Promise.resolve([...this.types]);
  }
  clauses(): Promise<readonly ClauseOnFile[]> {
    return Promise.resolve([...this.clauseRows]);
  }
  organizations(): Promise<readonly OrganizationOnFile[]> {
    return Promise.resolve([...this.orgs]);
  }
  identifierHolders(
    _tenantId: string,
    wanted: readonly { readonly type: IdentifierType; readonly value: string }[],
  ): Promise<readonly IdentifierHolder[]> {
    return Promise.resolve(
      this.holders.filter((h) => wanted.some((w) => w.type === h.type && w.value === h.value)),
    );
  }
  peopleByEmail(_tenantId: string, emails: readonly string[]): Promise<readonly PersonOnFile[]> {
    return Promise.resolve(this.peopleRows.filter((p) => emails.includes(p.email)));
  }
  engagementsInForce(): Promise<readonly EngagementInForce[]> {
    return Promise.resolve([...this.inForce]);
  }
  missedFromOn(): Promise<string | null> {
    return Promise.resolve(this.floor);
  }
}

// ── The writers ──────────────────────────────────────────────────────────────

export interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
}

/** A writer that records and never refuses — unless told to at one step.
 *  Only the calls that CREATE something mint an id, so a test can predict
 *  which party is which by the order of creation alone. */
class Recorder {
  readonly calls: RecordedCall[] = [];
  private failing: { method: string; matches: (input: unknown) => boolean } | null = null;
  private next = 1;

  constructor(private readonly prefix: string) {}

  failOn(method: string, matches: (input: unknown) => boolean = () => true): this {
    this.failing = { method, matches };
    return this;
  }

  protected record(method: string, input: unknown): void {
    if (this.failing !== null && this.failing.method === method && this.failing.matches(input)) {
      throw new Error(`${this.prefix} refused ${method}`);
    }
    this.calls.push({ method, input });
  }

  protected mint(): string {
    const id = `${this.prefix}-${String(this.next).padStart(4, "0")}`;
    this.next += 1;
    return id;
  }

  of(method: string): readonly RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

export class RecordingPartyWriter extends Recorder implements PartyWriter {
  constructor() {
    super("party");
  }
  createOrganization(input: Parameters<PartyWriter["createOrganization"]>[0], _actor: Actor) {
    this.record("createOrganization", input);
    return Promise.resolve({ partyId: this.mint() });
  }
  createPerson(input: Parameters<PartyWriter["createPerson"]>[0], _actor: Actor) {
    this.record("createPerson", input);
    return Promise.resolve({ partyId: this.mint() });
  }
  registerLegalEntity(input: Parameters<PartyWriter["registerLegalEntity"]>[0], _actor: Actor) {
    this.record("registerLegalEntity", input);
    return Promise.resolve();
  }
  addIdentifier(input: Parameters<PartyWriter["addIdentifier"]>[0], _actor: Actor) {
    this.record("addIdentifier", input);
    return Promise.resolve();
  }
  addRelationship(input: Parameters<PartyWriter["addRelationship"]>[0], _actor: Actor) {
    this.record("addRelationship", input);
    return Promise.resolve();
  }
}

export class RecordingAssignmentWriter extends Recorder implements AssignmentWriter {
  constructor() {
    super("assignment");
  }
  assign(input: Parameters<AssignmentWriter["assign"]>[0], _actor: Actor) {
    this.record("assign", input);
    return Promise.resolve();
  }
}

/** The feed's rates for an import, as a test states them (0345): one for the
 *  firm's own currency, `rates` for the rest, null for anything else. */
export class FixedImportRates implements ImportRates {
  constructor(
    readonly rates: Record<string, string> = { USD: "84.1", AED: "22.75", SGD: "64.5", GBP: "112.3" },
    readonly firmCurrency = "INR",
  ) {}
  readonly asked: { currency: string; on: string }[] = [];
  quote(_tenantId: string, currency: string, on: string) {
    this.asked.push({ currency, on });
    if (currency === this.firmCurrency) return Promise.resolve({ fxRate: "1", fxRateDate: on, source: "Same currency" });
    const rate = this.rates[currency];
    return Promise.resolve(rate === undefined ? null : { fxRate: rate, fxRateDate: on, source: "Currency API" });
  }
}

export class RecordingLetterWriter extends Recorder implements LetterWriter {
  constructor() {
    super("letter");
  }
  draft(input: Parameters<LetterWriter["draft"]>[0], _actor: Actor) {
    this.record("draft", input);
    return Promise.resolve({ id: this.mint() });
  }
  addLine(input: Parameters<LetterWriter["addLine"]>[0]) {
    this.record("addLine", input);
    return Promise.resolve();
  }
  setRate(input: Parameters<LetterWriter["setRate"]>[0], _actor: Actor) {
    this.record("setRate", input);
    return Promise.resolve();
  }
  addClause(tenantId: string, letterId: string, clauseVersionId: string): Promise<void> {
    this.record("addClause", { tenantId, letterId, clauseVersionId });
    return Promise.resolve();
  }
  send(tenantId: string, letterId: string, _actor: Actor) {
    this.record("send", { tenantId, letterId });
    return Promise.resolve();
  }
  sign(input: Parameters<LetterWriter["sign"]>[0], _actor: Actor) {
    const lines = this.of("addLine").filter(
      (c) => (c.input as { letterId: string }).letterId === input.letterId,
    ).length;
    this.record("sign", input);
    return Promise.resolve({
      engagements: Array.from({ length: lines }, (_, i) => ({
        engagement: { id: `${input.letterId}-engagement-${String(i + 1)}` },
      })),
    });
  }
}

// ── The portal — invite, grant, and the roster lookup between them ──────────

/** Emails this fake treats as already holding a CLIENT_PORTAL login at the
 *  firm — `invite()` throws the real `MembershipExists` for them, exactly as
 *  `TenancyService.inviteMember` does. */
export class RecordingPortalInviteWriter extends Recorder implements PortalInviteWriter {
  private readonly existing = new Set<string>();

  constructor() {
    super("portal-invite");
  }

  /** Mark an email as already invited, so the next `invite()` for it refuses
   *  the way a real second invite would. */
  withExisting(email: string): this {
    this.existing.add(email.trim().toLowerCase());
    return this;
  }

  invite(input: Parameters<PortalInviteWriter["invite"]>[0], _actor: Actor) {
    if (this.existing.has(input.email.trim().toLowerCase())) {
      return Promise.reject(new MembershipExists(input.email, "CLIENT_PORTAL"));
    }
    this.record("invite", input);
    this.existing.add(input.email.trim().toLowerCase());
    return Promise.resolve({ membershipId: this.mint() });
  }
}

/** `clientPartyId:membershipId` pairs this fake treats as already granted —
 *  `grant()` throws the real `PortalGrantDuplicate` for them, exactly as
 *  `PortalAccessService.grant` does under its exclusion constraint. */
export class RecordingPortalAccessGranter extends Recorder implements PortalAccessGranter {
  private readonly existing = new Set<string>();

  constructor() {
    super("portal-grant");
  }

  withExisting(membershipId: string, clientPartyId: string): this {
    this.existing.add(`${clientPartyId}:${membershipId}`);
    return this;
  }

  grant(input: Parameters<PortalAccessGranter["grant"]>[0], _actor: Actor) {
    const key = `${input.clientPartyId}:${input.membershipId}`;
    if (this.existing.has(key)) return Promise.reject(new PortalGrantDuplicate("this client"));
    this.record("grant", input);
    this.existing.add(key);
    return Promise.resolve({ id: this.mint() });
  }
}

/** A plain map standing in for the roster lookup the composition root
 *  satisfies with a closure — seeded directly, since there is no service
 *  behind the real one to fake. */
export class FakePortalMemberFinder implements PortalMemberFinder {
  private readonly byEmail = new Map<string, string>();

  withMembership(email: string, membershipId: string): this {
    this.byEmail.set(email.trim().toLowerCase(), membershipId);
    return this;
  }

  findClientMembership(_tenantId: string, email: string): Promise<{ readonly membershipId: string } | null> {
    const found = this.byEmail.get(email.trim().toLowerCase());
    return Promise.resolve(found === undefined ? null : { membershipId: found });
  }
}
