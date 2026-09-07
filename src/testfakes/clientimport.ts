// In-memory fakes for the client import's ports.
//
// The directory fake is seeded with `with…()` calls; the three writer fakes
// RECORD every call in order and hand back sequential ids, so a test can
// assert exactly which doors the import walked through and in what order —
// which is the whole claim of the module. `failOn(step)` makes one writer
// throw, for the partial-run tests.

import type { Actor } from "../domain/ledger/model";
import type { IdentifierType } from "../domain/party/model";
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
  LetterWriter,
  NewStagedImport,
  OrganizationOnFile,
  PartyWriter,
  PersonOnFile,
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
  withStaff(email: string, userId: string): this {
    this.staff.push({ email, userId });
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
