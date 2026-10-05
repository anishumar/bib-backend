// Where a client pays, and the LUT an export goes under (Q056, S5, 0369): the
// two things a GST tax invoice prints that belong to the ISSUING COMPANY, not
// to the invoice. Business rules against a port; no SQL here.
//
// BOTH ARE WRITTEN ONCE. An issued invoice points at the account and the LUT it
// printed, so a correction retires the row and writes a new one (the adapter
// does both in one transaction), and an issued invoice keeps saying what it
// said.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import {
  CompanyRecordNotFound,
  InvalidCompanyInvoicing,
  InvoiceIssuerNotAFirmEntity,
} from "../../domain/invoice/errors";
import { normalizeCurrency, isCurrencyCode } from "../../domain/money/model";
import type { BankAccountView, FirmEntities, PartyStanding } from "./ports";

export interface CompanyLut {
  readonly id: string;
  readonly financialYear: number;
  readonly reference: string;
  readonly filedOn: string | null;
}

/** One of the firm's companies, as its invoices see it. */
export interface CompanyInvoicing {
  readonly entityPartyId: string;
  readonly name: string;
  readonly country: string | null;
  /** The GSTIN in force today, or null: an Indian company without one issues
   *  plain invoices. */
  readonly gstin: string | null;
  readonly bankAccounts: readonly BankAccountView[];
  readonly luts: readonly CompanyLut[];
  /** Q087 (0375): whether its invoices round the total to the whole unit. */
  readonly roundOff: boolean;
}

export interface NewBankAccount {
  readonly accountName: string;
  readonly accountNumber: string;
  readonly bankName: string;
  readonly branch: string | null;
  readonly ifsc: string | null;
  readonly swift: string | null;
  readonly iban: string | null;
  readonly currency: string | null;
}

export interface CompanyInvoicingRepository {
  list(tenantId: string): Promise<readonly CompanyInvoicing[]>;
  /** Writes the account, retiring the live one for the same currency (or the
   *  general one) in the same transaction. Returns the new id and the retired. */
  addBankAccount(
    tenantId: string,
    entityPartyId: string,
    id: string,
    account: NewBankAccount,
  ): Promise<{ readonly replaced: string | null }>;
  /** False when no live account of this company has that id. */
  retireBankAccount(tenantId: string, entityPartyId: string, accountId: string): Promise<boolean>;
  /** Writes the LUT, retiring the live one for the same year. */
  addLut(
    tenantId: string,
    entityPartyId: string,
    lut: { readonly id: string; readonly financialYear: number; readonly reference: string; readonly filedOn: string | null },
  ): Promise<{ readonly replaced: string | null }>;
  /** The retired LUT's year, or null when no live LUT of this company has that id. */
  retireLut(tenantId: string, entityPartyId: string, lutId: string): Promise<number | null>;
  /** Q087: set whether the company rounds its totals. Its value BEFORE, or null
   *  when it is not one of the firm's listed companies (nothing written). */
  setRoundOff(tenantId: string, entityPartyId: string, on: boolean): Promise<boolean | null>;
}

export interface CompanyInvoicingDeps {
  readonly companies: CompanyInvoicingRepository;
  readonly firmEntities: FirmEntities;
  readonly parties: PartyStanding;
  readonly ids: IdGen;
  readonly events: EventSink;
}

const text = (v: string | null | undefined): string | null => {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
};

export class CompanyInvoicingService {
  constructor(private readonly deps: CompanyInvoicingDeps) {}

  list(tenantId: string): Promise<readonly CompanyInvoicing[]> {
    return this.deps.companies.list(tenantId);
  }

  /**
   * Add where a company is paid, or correct it: an account for the same
   * currency (or the general one) is retired in the same write.
   */
  async addBankAccount(
    tenantId: string,
    entityPartyId: string,
    input: {
      readonly accountName: string;
      readonly accountNumber: string;
      readonly bankName: string;
      readonly branch?: string | null | undefined;
      readonly ifsc?: string | null | undefined;
      readonly swift?: string | null | undefined;
      readonly iban?: string | null | undefined;
      readonly currency?: string | null | undefined;
    },
    actor: Actor,
  ): Promise<{ readonly id: string }> {
    await this.requireCompany(tenantId, entityPartyId);
    const accountName = text(input.accountName);
    const bankName = text(input.bankName);
    const accountNumber = input.accountNumber.replace(/\s+/g, " ").trim();
    if (accountName === null || accountName.length > 200) {
      throw new InvalidCompanyInvoicing("Write the name the account is held in, as the bank has it (at most 200 characters).");
    }
    if (bankName === null || bankName.length > 200) {
      throw new InvalidCompanyInvoicing("Write the bank's name (at most 200 characters).");
    }
    if (!/^[A-Za-z0-9 -]{4,40}$/.test(accountNumber)) {
      throw new InvalidCompanyInvoicing("An account number is 4 to 40 letters, digits, spaces or hyphens.");
    }
    const branch = text(input.branch);
    if (branch !== null && branch.length > 200) throw new InvalidCompanyInvoicing("The branch is at most 200 characters.");
    const ifsc = text(input.ifsc)?.toUpperCase() ?? null;
    if (ifsc !== null && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
      throw new InvalidCompanyInvoicing("An IFSC is 11 characters: four letters, a zero, then six letters or digits, like HDFC0001234.");
    }
    const swift = text(input.swift)?.toUpperCase() ?? null;
    if (swift !== null && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) {
      throw new InvalidCompanyInvoicing("A SWIFT (BIC) code is 8 or 11 characters, like HDFCINBB.");
    }
    const iban = text(input.iban)?.toUpperCase().replace(/\s+/g, "") ?? null;
    if (iban !== null && !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(iban)) {
      throw new InvalidCompanyInvoicing("An IBAN starts with the country's two letters and two digits, like AE07 0331 2345 6789 0123 456.");
    }
    const rawCurrency = text(input.currency);
    const currency = rawCurrency === null ? null : normalizeCurrency(rawCurrency);
    if (currency !== null && !isCurrencyCode(currency)) {
      throw new InvalidCompanyInvoicing(`${JSON.stringify(rawCurrency)} is not a currency code, like INR or USD.`);
    }
    const id = this.deps.ids.newId();
    const { replaced } = await this.deps.companies.addBankAccount(tenantId, entityPartyId, id, {
      accountName,
      accountNumber,
      bankName,
      branch,
      ifsc,
      swift,
      iban,
      currency,
    });
    await this.deps.events.recordEvent({
      tenantId,
      verb: "firm_entity.bank_account_added",
      objectId: entityPartyId,
      actor,
      payload: { accountId: id, currency, replacesAccountId: replaced },
    });
    return { id };
  }

  async retireBankAccount(tenantId: string, entityPartyId: string, accountId: string, actor: Actor): Promise<void> {
    await this.requireCompany(tenantId, entityPartyId);
    if (!(await this.deps.companies.retireBankAccount(tenantId, entityPartyId, accountId))) {
      throw new CompanyRecordNotFound("bank account", accountId);
    }
    await this.deps.events.recordEvent({
      tenantId,
      verb: "firm_entity.bank_account_retired",
      objectId: entityPartyId,
      actor,
      payload: { accountId },
    });
  }

  /** Record an LUT for a financial year (the year it starts in), replacing the
   *  one for the same year. */
  async addLut(
    tenantId: string,
    entityPartyId: string,
    input: { readonly financialYear: number; readonly reference: string; readonly filedOn?: string | null | undefined },
    actor: Actor,
  ): Promise<{ readonly id: string }> {
    await this.requireCompany(tenantId, entityPartyId);
    if (!Number.isInteger(input.financialYear) || input.financialYear < 2017 || input.financialYear > 2100) {
      throw new InvalidCompanyInvoicing("Choose the financial year the LUT is for, like 2026-27.");
    }
    const reference = input.reference.trim().toUpperCase();
    if (!/^[A-Z0-9/-]{5,30}$/.test(reference)) {
      throw new InvalidCompanyInvoicing(
        "Write the LUT's ARN as the GST portal gave it: 5 to 30 letters or digits, like AD270426001234X.",
      );
    }
    const filedOn = text(input.filedOn);
    if (filedOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(filedOn)) {
      throw new InvalidCompanyInvoicing("The filing date is a day, like 2026-04-02.");
    }
    const id = this.deps.ids.newId();
    const { replaced } = await this.deps.companies.addLut(tenantId, entityPartyId, {
      id,
      financialYear: input.financialYear,
      reference,
      filedOn,
    });
    await this.deps.events.recordEvent({
      tenantId,
      verb: "firm_entity.lut_recorded",
      objectId: entityPartyId,
      actor,
      payload: { lutId: id, financialYear: input.financialYear, replacesLutId: replaced },
    });
    return { id };
  }

  async retireLut(tenantId: string, entityPartyId: string, lutId: string, actor: Actor): Promise<void> {
    await this.requireCompany(tenantId, entityPartyId);
    const year = await this.deps.companies.retireLut(tenantId, entityPartyId, lutId);
    if (year === null) throw new CompanyRecordNotFound("LUT", lutId);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "firm_entity.lut_retired",
      objectId: entityPartyId,
      actor,
      payload: { lutId, financialYear: year },
    });
  }

  /**
   * Q087 (10x, 2026-10-05: "round off"): the company's invoices round the total
   * to the whole unit with a Round off line. Drafts follow at once; an issued
   * invoice keeps what it did (frozen at issue, 0375).
   */
  async setRoundOff(tenantId: string, entityPartyId: string, on: boolean, actor: Actor): Promise<void> {
    await this.requireCompany(tenantId, entityPartyId);
    const before = await this.deps.companies.setRoundOff(tenantId, entityPartyId, on);
    if (before === null) {
      const name = (await this.deps.parties.findParty(tenantId, entityPartyId))?.displayName ?? entityPartyId;
      throw new InvoiceIssuerNotAFirmEntity(name);
    }
    if (before === on) return;
    await this.deps.events.recordEvent({
      tenantId,
      verb: "firm_entity.round_off_set",
      objectId: entityPartyId,
      actor,
      payload: { roundOff: on },
    });
  }

  private async requireCompany(tenantId: string, entityPartyId: string): Promise<void> {
    if (await this.deps.firmEntities.isFirmEntity(tenantId, entityPartyId)) return;
    const name = (await this.deps.parties.findParty(tenantId, entityPartyId))?.displayName ?? entityPartyId;
    throw new InvoiceIssuerNotAFirmEntity(name);
  }
}
