// The proposal use case composed over real Postgres, for the T6.18 integration
// tests — the same wiring pricing.integration.test.ts spells out by hand, in
// one place so three more files do not each carry a copy of it.
//
// Not a test file: no `.test.` in the name, so neither vitest config collects it.
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresLeadRepository } from "../../src/infrastructure/postgres/lead-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresProposalRepository } from "../../src/infrastructure/postgres/proposal-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresServiceAxisRepository } from "../../src/infrastructure/postgres/service-axis-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import {
  PostgresDocumentBlockRepository,
  PostgresStandardBlockRepository,
} from "../../src/infrastructure/postgres/block-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { PartyService } from "../../src/usecase/party/service";
import { ConfigService } from "../../src/usecase/config/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { DocumentService } from "../../src/usecase/document/service";
import { FAKE_PROPOSAL_LINKS, UNWIRED_PROPOSAL_PDFS } from "../../src/testfakes/proposal";
import { RandomTokenFactory } from "../../src/infrastructure/crypto/random-tokens";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";

export function composeProposals() {
  const cfg = load();
  const app = postgres(cfg.db.appUrl, { max: 2 });
  const owner = postgres(cfg.db.ownerUrl, { max: 2, onnotice: () => undefined });
  const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
  const configRepository = new PostgresConfigRepository(app);
  const config = new ConfigService({
    registry: configRepository,
    holders: new PostgresMembershipRepository(app),
    axes: new PostgresServiceAxisRepository(app),
    ids: systemIds,
    events: ledger,
  });
  const party = new PartyService({
    parties: new PostgresPartyRepository(app),
    identifiers: new PostgresIdentifierRepository(app),
    relationships: new PostgresRelationshipRepository(app),
    ids: systemIds,
    events: ledger,
  });
  const documentRepository = new PostgresDocumentRepository(app);
  const documents = new DocumentService({
    preferences: documentRepository,
    refs: documentRepository,
    standardBlocks: new PostgresStandardBlockRepository(app),
    blocks: new PostgresDocumentBlockRepository(app),
    ids: systemIds,
    events: ledger,
  });
  const repository = new PostgresProposalRepository(app);
  const proposals = new ProposalService({
    proposals: repository,
    catalogue: configRepository,
    policies: configRepository,
    parties: new PostgresPartyRepository(app),
    leads: new PostgresLeadRepository(app),
    documents,
    shareTokens: new RandomTokenFactory(),
    structure: new PostgresRelationshipRepository(app),
    timeZones: new PostgresFirmTimeZone(app),
    staff: new PostgresMembershipRepository(app),
    mailer: null,
    pdfs: UNWIRED_PROPOSAL_PDFS,
    links: FAKE_PROPOSAL_LINKS,
    ids: systemIds,
    clock: systemClock,
    events: ledger,
  });
  const end = (): Promise<unknown> => Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
  return { app, owner, ledger, config, party, documents, documentRepository, repository, proposals, end };
}
