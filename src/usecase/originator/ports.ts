// Who won the work of a letter, its ORIGINATOR (0355, Q049): the seams.

/** How the originator in force was arrived at: a person set it, or it was read
 *  off the deal (the lead's owner, else who prepared the proposal), or there
 *  is none. */
export type OriginatorHow = "set" | "lead_owner" | "proposal_preparer" | "none";

export interface LetterOriginatorRecord {
  readonly letterId: string;
  readonly letterRef: string;
  /** Deleted as made by mistake (0086): nothing about it changes again. */
  readonly deleted: boolean;
  /** Null = nobody: none recorded, or a person said nobody. */
  readonly userId: string | null;
  /** The name THIS firm's roster has for them; null for nobody. */
  readonly name: string | null;
  readonly activeStaff: boolean;
  readonly how: OriginatorHow;
  /** When a person last set it, and who; null while read off the deal. */
  readonly setAt: string | null;
  readonly setBy: { readonly userId: string; readonly name: string | null } | null;
}

export interface OriginatorStore {
  /** Null when there is no such letter at this firm. */
  find(tenantId: string, letterId: string): Promise<LetterOriginatorRecord | null>;
  /** Writes a person's word (the latest only; the ledger keeps the rest). */
  write(tenantId: string, letterId: string, userId: string | null, byUserId: string | null): Promise<void>;
  /** Active staff of THIS firm. */
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}
