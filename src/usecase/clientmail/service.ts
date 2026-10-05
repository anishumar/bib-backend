// The firm's client-mail setting (Q059, 0350): which mail domains the relay
// may send FROM.
//
// A client email always names its SPOC and replies to them (that needs no
// setting). Their own address becomes the From only when its domain is listed
// here, and a firm lists a domain only once its mail provider authorises this
// relay for it (SPF and DKIM): a From the relay is not allowed to use is
// refused or filed as spam, so the list starts empty and is the firm's
// administrator's to fill. Ledger `tenant.send_domains_set`, both sides.
import type { Actor } from "../../domain/ledger/model";
import { MAX_SEND_DOMAINS, normalizeSendDomain, sendDomainProblem } from "../../domain/mail/model";
import { InvalidSendDomain } from "../../domain/tenancy/errors";
import type { EventSink } from "../ledger/ports";

/** Where the list lives. Satisfied by `PostgresClientSenders`. */
export interface SendDomainStore {
  sendFromDomains(tenantId: string): Promise<readonly string[]>;
  setSendFromDomains(tenantId: string, domains: readonly string[]): Promise<void>;
}

export interface Deps {
  readonly store: SendDomainStore;
  readonly events: EventSink;
}

export class ClientMailService {
  constructor(private readonly deps: Deps) {}

  sendFromDomains(tenantId: string): Promise<readonly string[]> {
    return this.deps.store.sendFromDomains(tenantId);
  }

  /**
   * Replace the list. Each domain trimmed, lower-cased and checked; repeats
   * collapse; sorted, so the same list always reads the same. An unchanged list
   * writes nothing and records nothing.
   */
  async setSendFromDomains(tenantId: string, raw: readonly string[], actor: Actor): Promise<readonly string[]> {
    const domains = [...new Set(raw.map(normalizeSendDomain).filter((d) => d !== ""))].sort();
    for (const d of domains) {
      const problem = sendDomainProblem(d);
      if (problem !== null) throw new InvalidSendDomain(problem);
    }
    if (domains.length > MAX_SEND_DOMAINS) {
      throw new InvalidSendDomain(`List at most ${String(MAX_SEND_DOMAINS)} domains.`);
    }
    const from = [...(await this.deps.store.sendFromDomains(tenantId))].sort();
    if (from.length === domains.length && from.every((d, i) => d === domains[i])) return domains;
    await this.deps.store.setSendFromDomains(tenantId, domains);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "tenant.send_domains_set",
      objectId: tenantId,
      actor,
      payload: { from, to: domains },
    });
    return domains;
  }
}
