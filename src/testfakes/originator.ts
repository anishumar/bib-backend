// In-memory originator store (0355, Q049): letters with what the deal says,
// a person's word on top, and the firm's active staff.
import type { LetterOriginatorRecord, OriginatorHow, OriginatorStore } from "../usecase/originator/ports";

export class FakeOriginatorStore implements OriginatorStore {
  /** letter id -> the letter and what its deal says (no person's word yet). */
  readonly letters = new Map<
    string,
    { tenantId: string; ref: string; deleted?: boolean; dealUserId: string | null; dealHow: OriginatorHow }
  >();
  /** letter id -> a person's word. */
  readonly words = new Map<string, { userId: string | null; byUserId: string | null }>();
  readonly staff = new Set<string>();
  readonly names = new Map<string, string>();

  find(tenantId: string, letterId: string): Promise<LetterOriginatorRecord | null> {
    const l = this.letters.get(letterId);
    if (l === undefined || l.tenantId !== tenantId) return Promise.resolve(null);
    const word = this.words.get(letterId);
    const userId = word === undefined ? l.dealUserId : word.userId;
    return Promise.resolve({
      letterId,
      letterRef: l.ref,
      deleted: l.deleted ?? false,
      userId,
      name: userId === null ? null : (this.names.get(userId) ?? null),
      activeStaff: userId !== null && this.staff.has(userId),
      how: word === undefined ? l.dealHow : "set",
      setAt: word === undefined ? null : "2026-10-05T06:00:00.000Z",
      setBy:
        word === undefined || word.byUserId === null
          ? null
          : { userId: word.byUserId, name: this.names.get(word.byUserId) ?? null },
    });
  }

  write(_tenantId: string, letterId: string, userId: string | null, byUserId: string | null): Promise<void> {
    this.words.set(letterId, { userId, byUserId });
    return Promise.resolve();
  }

  isActiveStaff(_tenantId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.staff.has(userId));
  }
}
