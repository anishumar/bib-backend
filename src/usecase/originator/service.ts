// Who won the work of a letter, its ORIGINATOR (0355, Q049). No I/O.
//
// Ashish, 4 Oct 2026: revenue is tracked manager-wise AND salesperson-wise.
// The manager is on every invoice (0318). The salesperson is the letter's
// originator: one per letter, the deal (the user, 2026-10-05), read off the
// deal until a partner or an administrator says otherwise (the route holds
// `tenant:admin`, which the default Partner role has). Every change is ledgered.
import type { Actor } from "../../domain/ledger/model";
import { LetterDeleted, LetterNotFound, OriginatorNotStaff } from "../../domain/engagement/errors";
import type { EventSink } from "../ledger/ports";
import type { LetterOriginatorRecord, OriginatorStore } from "./ports";

export interface OriginatorDeps {
  readonly store: OriginatorStore;
  readonly events: EventSink;
}

export class OriginatorService {
  constructor(private readonly deps: OriginatorDeps) {}

  async get(tenantId: string, letterId: string): Promise<LetterOriginatorRecord> {
    const found = await this.deps.store.find(tenantId, letterId);
    if (found === null) throw new LetterNotFound(letterId);
    return found;
  }

  /**
   * A partner or an administrator says who won the work, or that nobody did
   * (`userId` null). Only active staff of this firm may be credited. Setting
   * the person already set records nothing.
   */
  async set(
    input: { readonly tenantId: string; readonly letterId: string; readonly userId: string | null },
    actor: Actor,
  ): Promise<LetterOriginatorRecord> {
    const current = await this.get(input.tenantId, input.letterId);
    if (current.deleted) throw new LetterDeleted(current.letterRef);
    if (input.userId !== null && !(await this.deps.store.isActiveStaff(input.tenantId, input.userId))) {
      throw new OriginatorNotStaff();
    }
    if (current.how === "set" && current.userId === input.userId) return current;
    await this.deps.store.write(input.tenantId, input.letterId, input.userId, actor.type === "human" ? actor.id : null);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "engagement_letter.originator_set",
      objectId: input.letterId,
      actor,
      payload: {
        originatorUserId: input.userId,
        previousOriginatorUserId: current.userId,
        previousHow: current.how,
      },
    });
    return this.get(input.tenantId, input.letterId);
  }
}
