// The two letters of 0085 — what a client and a colleague actually receive.
//
// The proposal email is the portal invite's problem again: it arrives at
// somebody outside the firm with links in it, so it has to name the firm, say
// what each link does before anybody presses it, and send a reply to a person.
// And its buttons must not ANSWER — company mail filters open every link in a
// message — which the letter says out loud, and this file checks it does.
import { describe, expect, it } from "vitest";
import { SmtpMailer } from "../../src/infrastructure/mail/smtp-mailer";
import type { Letter, MailTransport } from "../../src/infrastructure/mail/smtp-mailer";
import type { ProposalLetter } from "../../src/usecase/proposal/ports";

class Captured implements MailTransport {
  readonly sent: Letter[] = [];
  send(letter: Letter): Promise<void> {
    this.sent.push(letter);
    return Promise.resolve();
  }
}

function only(t: Captured): Letter {
  const [letter] = t.sent;
  if (letter === undefined) throw new Error("nothing was sent");
  return letter;
}

const VIEW = "https://app.example.com/p/tenant.secret";
const LETTER: ProposalLetter = {
  to: "priya@nexusfintech.in",
  replyTo: "sahil@10xglobal.in",
  sender: null,
  firmName: "10X Global Inc.",
  preparedBy: "Sahil Kohli",
  greetingName: "Priya Sharma",
  clientName: "Nexus Fintech",
  ref: "PR-2026-0001",
  title: "Proposal for Services",
  validUntil: "2026-10-31",
  note: null,
  viewUrl: VIEW,
  acceptUrl: `${VIEW}?answer=accept`,
  declineUrl: `${VIEW}?answer=decline`,
  pdf: { filename: "PR-2026-0001.pdf", bytes: new Uint8Array([37, 80, 68, 70]) },
};

function send(overrides: Partial<ProposalLetter> = {}): Letter {
  const t = new Captured();
  void new SmtpMailer(t).sendProposal({ ...LETTER, ...overrides });
  return only(t);
}

describe("the proposal email", () => {
  it("comes FROM the firm, names it in the subject, and replies to a person", () => {
    const letter = send();
    expect(letter.fromName).toBe("10X Global Inc.");
    expect(letter.subject).toBe("Proposal PR-2026-0001 from 10X Global Inc.");
    expect(letter.replyTo).toBe("sahil@10xglobal.in");
    expect(letter.text).toContain("Questions? Reply to this email and it reaches Sahil Kohli.");
  });

  it("is from the client's SPOC by name and replies to them, over the preparer (Q059)", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendProposal({
      ...LETTER,
      sender: { name: "Priya Sharma", email: "priya@10xglobal.in", ownAddress: true },
    });
    const letter = only(t);
    expect(letter.fromName).toBe("Priya Sharma, 10X Global Inc.");
    expect(letter.fromAddress).toBe("priya@10xglobal.in");
    expect(letter.replyTo).toEqual({ name: "Priya Sharma", address: "priya@10xglobal.in" });
    expect(letter.text).toContain("Reply to this email and it reaches Priya Sharma.");
  });

  it("attaches the PDF, as a PDF", () => {
    expect(send().attachments).toEqual([
      { filename: "PR-2026-0001.pdf", contentType: "application/pdf", content: LETTER.pdf.bytes },
    ]);
  });

  it("carries accept and decline in both bodies", () => {
    const letter = send();
    for (const url of [LETTER.acceptUrl, LETTER.declineUrl]) {
      expect(letter.text).toContain(url);
      expect(letter.html).toContain(url);
    }
    expect(letter.html).toContain("Accept proposal");
    expect(letter.html).toContain("Decline");
  });

  it("says the PDF is attached, in bold, and offers no separate 'read it online' link", () => {
    // Asked for on 2026-09-26: the attachment is the proposal, so the sentence
    // saying so stands out, and the extra link is gone. The page's address
    // survives only as the fallback under the buttons, for a mail app that
    // draws no buttons at all.
    const letter = send();
    expect(letter.html).toContain("<strong>The PDF is attached.</strong>");
    expect(letter.text).toContain("The PDF is attached.");
    expect(letter.html).not.toContain("read it online");
    expect(letter.text).not.toContain("read it online");
    expect(letter.text).not.toContain(LETTER.viewUrl + "\n");
    expect(letter.html).toContain("If the button does not work");
  });

  it("says nothing is decided by opening a link — because nothing is", () => {
    const letter = send();
    expect(letter.text).toContain("Nothing is decided by opening it.");
    expect(letter.html).toContain("Nothing is decided by opening it.");
  });

  it("greets the person it was prepared for, and says how long the offer stands", () => {
    const letter = send();
    expect(letter.text.startsWith("Dear Priya Sharma,")).toBe(true);
    expect(letter.text).toContain("It is valid until 31 Oct 2026.");
  });

  it("greets nobody by name when it was prepared for nobody, and states no date it lacks", () => {
    const letter = send({ greetingName: null, validUntil: null });
    expect(letter.text.startsWith("Hello,")).toBe(true);
    expect(letter.text).not.toContain("valid until");
  });

  it("puts the colleague's own words first, escaped, with their line breaks", () => {
    const letter = send({ note: "As discussed:\n<b>fees</b> & scope" });
    expect(letter.text).toContain("As discussed:\n<b>fees</b> & scope");
    expect(letter.html).toContain("As discussed:<br>&lt;b&gt;fees&lt;/b&gt; &amp; scope");
  });

  it("cannot be given a second header by a firm's name", () => {
    // A header ends at a newline, so a name carrying one could append its own —
    // a Bcc: among them. The name is flattened before it reaches the subject.
    const letter = send({ firmName: "Evil Co\r\nBcc: everyone@example.com" });
    expect(letter.subject).not.toMatch(/[\r\n]/);
    expect(letter.fromName).not.toMatch(/[\r\n]/);
  });
});

describe("the notice to the colleague who prepared it", () => {
  const base = {
    to: "sahil@10xglobal.in",
    clientName: "Nexus Fintech",
    ref: "PR-2026-0001",
    title: "Proposal for Services",
    signerName: "Priya Sharma",
    decidedAt: "2026-09-26T11:32:00.000Z",
    declinedReason: null,
    proposalUrl: "https://app.example.com/proposals/abc",
  };

  it("says who accepted, when — in a named zone — and where to go next", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendDecisionNotice({ ...base, decision: "accepted" });
    const letter = only(t);
    expect(letter.to).toBe("sahil@10xglobal.in");
    expect(letter.subject).toBe("Nexus Fintech accepted PR-2026-0001");
    expect(letter.text).toContain("Priya Sharma accepted proposal PR-2026-0001");
    expect(letter.text).toContain("26 September 2026, 11:32 UTC");
    expect(letter.text).toContain(base.proposalUrl);
    expect(letter.text).toContain("engagement letter");
  });

  it("carries the reason on a decline, and says so when there is none", () => {
    const t = new Captured();
    const mailer = new SmtpMailer(t);
    void mailer.sendDecisionNotice({
      ...base,
      decision: "rejected",
      declinedReason: "Staying with our auditor.",
    });
    void mailer.sendDecisionNotice({ ...base, decision: "rejected" });
    expect(t.sent[0]?.subject).toBe("Nexus Fintech declined PR-2026-0001");
    expect(t.sent[0]?.text).toContain('The reason they gave: "Staying with our auditor."');
    expect(t.sent[1]?.text).toContain("They gave no reason.");
  });

  it("comes from the firm by name, never another firm's (CA#12, audit 2026-10-03)", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendDecisionNotice({ ...base, decision: "accepted", firmName: "Sharma Mehta & Co" });
    expect(only(t).fromName).toBe("Sharma Mehta & Co");
    const unnamed = new Captured();
    void new SmtpMailer(unnamed).sendDecisionNotice({ ...base, decision: "accepted" });
    expect(only(unnamed).fromName).toBeUndefined();
  });
});
