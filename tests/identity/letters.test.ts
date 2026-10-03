// What a client actually receives — read, rather than assumed.
//
// The letters are the half of the mailer with judgement in them, and until now
// nothing in this product had ever put words in front of a person outside the
// firm. `LoggingMailer` wrote a URL to a log; a log line has no subject, no
// sender and nobody to convince.
//
// ── THE INVITE IS INDISTINGUISHABLE FROM PHISHING UNLESS IT WORKS AT IT ─────
//
// It arrives unasked, at somebody who never signed up, from an address they
// have no reason to recognise, and asks them to open a link and set a password.
// Every one of those is a phishing signal. So the letter has to name the firm
// where the reader will look first — the SUBJECT — and say what to do if it was
// not expected, and the test asserts both rather than trusting a comment.
//
// `MailTransport` is the seam that makes this possible without a network: the
// vendor lives in `nodemailer-transport.ts` and nothing here touches SMTP.
import { describe, expect, it } from "vitest";
import { SmtpMailer } from "../../src/infrastructure/mail/smtp-mailer";
import type { Letter, MailTransport } from "../../src/infrastructure/mail/smtp-mailer";

class Captured implements MailTransport {
  readonly sent: Letter[] = [];
  send(letter: Letter): Promise<void> {
    this.sent.push(letter);
    return Promise.resolve();
  }
}

/** One letter, or a failure that says none was sent — never `sent[0]!`. */
function only(t: Captured): Letter {
  const [letter] = t.sent;
  if (letter === undefined) throw new Error("nothing was sent");
  return letter;
}

const URL = "https://app.example.com/portal/accept-invite?token=abc123";
const EXPIRES = "2026-09-02T14:05:00.000Z";

describe("the sign-in link", () => {
  it("carries the link, in both bodies", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendMagicLink("meera@cobaltfoods.in", URL, EXPIRES);
    const letter = only(t);

    expect(letter.to).toBe("meera@cobaltfoods.in");
    expect(letter.text).toContain(URL);
    // Not a fallback nobody reads: a plain-text client, a screen reader and
    // every spam filter look at `text`, and an HTML-only letter scores worse.
    expect(letter.html).toContain(URL);
    expect(letter.text.length).toBeGreaterThan(0);
  });

  it("says the link works ONCE, because it does", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendMagicLink("meera@cobaltfoods.in", URL, EXPIRES);
    expect(only(t).text).toMatch(/works ONCE/);
  });

  it("NAMES THE ZONE on the expiry — the reader's own is unknowable here", () => {
    // An email has no browser to ask, so the choice is between a zone nobody
    // chose and a zone that is said out loud. `instant.ts` (T6.10) settled the
    // same question for every date the product renders: name it.
    const t = new Captured();
    void new SmtpMailer(t).sendMagicLink("meera@cobaltfoods.in", URL, EXPIRES);
    const letter = only(t);
    expect(letter.text).toContain("2 September 2026, 14:05 UTC");
    expect(letter.html).toContain("2 September 2026, 14:05 UTC");
  });

  it("tells somebody who did not ask for it that nothing has happened", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendMagicLink("meera@cobaltfoods.in", URL, EXPIRES);
    expect(only(t).text).toMatch(/did not ask for this/);
  });
});

describe("the portal invite — the letter that must not read as phishing", () => {
  it("names the firm in the SUBJECT, which is where the reader looks first", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite("meera@cobaltfoods.in", URL, EXPIRES, "10x Global");
    const letter = only(t);

    expect(letter.subject).toContain("10x Global");
    expect(letter.text).toContain("10x Global");
    expect(letter.html).toContain("10x Global");
  });

  it("says what to do if it was NOT expected — and not 'reply to this'", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite("meera@cobaltfoods.in", URL, EXPIRES, "10x Global");
    const letter = only(t);
    // Check with your own contact, through a channel this letter did not
    // supply. Replying to a phishing email reaches the phisher.
    expect(letter.text).toMatch(/not expecting this/);
    expect(letter.text).toMatch(/rather than replying/);
  });

  it("says what they will be able to DO, so the click has a reason", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite("meera@cobaltfoods.in", URL, EXPIRES, "10x Global");
    expect(only(t).text).toMatch(/send them|find things|invoiced/);
  });

  it("STILL SENDS when the firm's name does not resolve, and says less", () => {
    // `PortalInviteService` passes null when the tenant row does not resolve,
    // and its own comment is explicit that the letter should go anyway rather
    // than trapping a client outside. So the wording degrades; it does not
    // become untrue, and it does not throw.
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite("meera@cobaltfoods.in", URL, EXPIRES, null);
    const letter = only(t);

    expect(letter.subject).toBe("You have been invited to a client portal");
    expect(letter.text).toContain("The firm you work with");
    expect(letter.text).toContain(URL);
    expect(letter.text).not.toContain("null");
  });
});

describe("the staff welcome — unasked-for too, and it must not sell a password", () => {
  const WELCOME = "https://app.example.com/auth/magic-link?token=abc123";

  it("names the firm in the SUBJECT, for the same reason the invite does", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendStaffWelcome("priya@10xglobal.in", WELCOME, EXPIRES, "10x Global");
    const letter = only(t);

    expect(letter.subject).toContain("10x Global");
    expect(letter.text).toContain("10x Global");
    expect(letter.html).toContain("10x Global");
  });

  it("does NOT tell a colleague to choose a password — there is no such screen", () => {
    // The one thing it must not copy from the portal invite. Staff sign in with
    // the link; no product route sets a staff password, so an instruction to
    // pick one would send somebody looking for a page that does not exist.
    const t = new Captured();
    void new SmtpMailer(t).sendStaffWelcome("priya@10xglobal.in", WELCOME, EXPIRES, "10x Global");
    const letter = only(t);

    expect(letter.text).not.toMatch(/password/i);
    expect(letter.html).not.toMatch(/password/i);
    expect(letter.text).toContain(WELCOME);
    expect(letter.html).toContain(WELCOME);
  });

  it("says the expiry is SURVIVABLE, which is what buys the 72-hour life", () => {
    // The client's invite gets a week because a client whose link died has to
    // go back and ask a human. A colleague does not — the sign-in page issues
    // another one — and the letter has to SAY so, or the reader who opens it
    // late believes they are locked out and asks somebody instead.
    const t = new Captured();
    void new SmtpMailer(t).sendStaffWelcome("priya@10xglobal.in", WELCOME, EXPIRES, "10x Global");
    const letter = only(t);

    expect(letter.text).toMatch(/works ONCE/);
    expect(letter.text).toMatch(/expired/);
    expect(letter.text).toMatch(/ask for a\s+new link/);
  });

  it("says what to do if it was NOT expected — and not 'reply to this'", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendStaffWelcome("priya@10xglobal.in", WELCOME, EXPIRES, "10x Global");
    const letter = only(t);

    expect(letter.text).toMatch(/not expecting this/);
    expect(letter.text).toMatch(/rather than replying/);
  });

  it("STILL SENDS when the firm's name does not resolve, and says less", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendStaffWelcome("priya@10xglobal.in", WELCOME, EXPIRES, null);
    const letter = only(t);

    expect(letter.subject).toBe("You have been given access to BiB");
    expect(letter.text).toContain("The firm you work at");
    expect(letter.text).not.toContain("null");
  });

  it("is a DIFFERENT letter from the invite, which is why it is a third method", () => {
    // Both are pushed at somebody who did not ask, and that is where the
    // similarity ends. A test that only checked "an email went" would pass on
    // an implementation that mailed a colleague the client's portal invite.
    const t = new Captured();
    const mailer = new SmtpMailer(t);
    void mailer.sendStaffWelcome("priya@10xglobal.in", WELCOME, EXPIRES, "10x Global");
    void mailer.sendPortalInvite("meera@cobaltfoods.in", URL, EXPIRES, "10x Global");
    const [welcome, invite] = t.sent;
    if (welcome === undefined || invite === undefined) throw new Error("expected two letters");

    expect(welcome.subject).not.toBe(invite.subject);
    expect(welcome.text).not.toBe(invite.text);
    expect(invite.text).toMatch(/client portal/);
    expect(welcome.text).not.toMatch(/client portal/);
  });
});

describe("the password reset — the one letter whose 'ignore this' is load-bearing", () => {
  const RESET = "https://app.example.com/auth/reset-password?token=abc123";

  function reset(): Letter {
    const t = new Captured();
    void new SmtpMailer(t).sendPasswordReset("meera@cobaltfoods.in", RESET, EXPIRES);
    return only(t);
  }

  it("carries the link in both bodies, and names the act in the subject", () => {
    const letter = reset();
    expect(letter.to).toBe("meera@cobaltfoods.in");
    expect(letter.subject).toMatch(/[Rr]eset your .* password/);
    expect(letter.text).toContain(RESET);
    expect(letter.html).toContain(RESET);
  });

  it("tells somebody who did NOT ask that their password has not changed", () => {
    // THE SENTENCE THIS WHOLE METHOD EXISTS FOR, and it is the one the sign-in
    // link must NOT be copied for. That letter closes with "nothing has
    // happened and you can ignore this message", which is true of a link that
    // opens a session and false of one that REPLACES a credential. A reader who
    // did not ask for this needs both halves: the password still works, and it
    // goes on working as long as the link is left alone.
    const letter = reset();
    expect(letter.text).toMatch(/your password has NOT changed/i);
    expect(letter.text).toMatch(/leave this link alone/i);
    expect(letter.html).toMatch(/your password has not changed/i);
  });

  it("says the link works ONCE and that asking again cancels it", () => {
    // Both facts, because both are true and the second is the answer to the
    // thing people actually do — press the button again, then open the first
    // letter because it is higher up the inbox.
    const letter = reset();
    expect(letter.text).toMatch(/works ONCE/);
    expect(letter.text).toMatch(/cancels this/i);
  });

  it("NAMES THE ZONE on the expiry, like every other letter here", () => {
    expect(reset().text).toContain("2 September 2026, 14:05 UTC");
  });

  it("names NO firm, unlike the three unasked-for letters", () => {
    // The account is GLOBAL (ADR-02) — one login, however many firms — so there
    // is no single firm this letter could name without telling the reader
    // something false about which password is being reset. It does not need the
    // anti-phishing sentence the others carry for the same reason it does not
    // need a firm: it was asked for seconds ago.
    const letter = reset();
    expect(letter.text).not.toMatch(/check with your contact/i);
    expect(letter.subject).not.toMatch(/has (invited|added|given)/);
  });

  it("is a DIFFERENT letter from the sign-in link, which is why it is a fifth method", () => {
    const a = new Captured();
    void new SmtpMailer(a).sendMagicLink("meera@cobaltfoods.in", RESET, EXPIRES);
    const b = new Captured();
    void new SmtpMailer(b).sendPasswordReset("meera@cobaltfoods.in", RESET, EXPIRES);

    expect(only(a).subject).not.toBe(only(b).subject);
    // The sign-in letter's closing line is exactly the one that would be wrong
    // here, so a copy-paste of it fails this.
    expect(only(a).text).toMatch(/nothing has happened/);
    expect(only(b).text).not.toMatch(/nothing has happened/);
  });
});

describe("a firm's name is data, and reaches a header and a document", () => {
  it("cannot inject a header — a newline in the name would end the Subject", () => {
    // A header ends at a newline, so a name carrying one could append headers
    // of its own, a `Bcc:` among them. Whoever provisioned the tenant wrote
    // this string; that is not the same as it being trustworthy.
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite(
      "meera@cobaltfoods.in",
      URL,
      EXPIRES,
      "10x Global\r\nBcc: attacker@example.com",
    );
    const letter = only(t);

    expect(letter.subject).not.toContain("\n");
    expect(letter.subject).not.toContain("\r");
    expect(letter.subject).toBe("10x Global Bcc: attacker@example.com has invited you to their client portal");
  });

  it("treats a name that is only whitespace as no name at all", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite("meera@cobaltfoods.in", URL, EXPIRES, "  \r\n ");
    expect(only(t).subject).toBe("You have been invited to a client portal");
  });

  it("escapes the name in the HTML — real company names carry & and '", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite(
      "meera@cobaltfoods.in",
      URL,
      EXPIRES,
      "Shah & Shah <Chartered Accountants>",
    );
    const letter = only(t);

    expect(letter.html).toContain("Shah &amp; Shah &lt;Chartered Accountants&gt;");
    expect(letter.html).not.toContain("<Chartered");
    // The plain-text half is not markup and keeps the real characters.
    expect(letter.text).toContain("Shah & Shah <Chartered Accountants>");
  });
});

describe("the HTML is built for mail clients, not for a browser", () => {
  it("loads nothing from anywhere", () => {
    // Images are blocked by default (a logo-shaped hole is worse than no
    // logo), `<style>` is dropped by most clients, and a script is a reason to
    // be filtered. Everything is inline or it does not survive Outlook.
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite("meera@cobaltfoods.in", URL, EXPIRES, "10x Global");
    const letter = only(t);

    expect(letter.html).not.toMatch(/<img/i);
    expect(letter.html).not.toMatch(/<script/i);
    expect(letter.html).not.toMatch(/<style/i);
    expect(letter.html).not.toMatch(/<link/i);
  });

  it("prints the link in full as well as on a button", () => {
    // A button is not copyable, and some clients render none at all.
    const t = new Captured();
    void new SmtpMailer(t).sendMagicLink("meera@cobaltfoods.in", URL, EXPIRES);
    const letter = only(t);
    expect(letter.html).toMatch(/copy this into your browser/);
  });
});

describe("a letter from a firm says the time on the firm's clock (audit 2026-10-03, CA#50)", () => {
  // An Indian firm's new colleague read "works until 6 Oct 06:53 UTC". The
  // letters that come FROM a firm now say the time where the firm is, and
  // name that zone in words; the two a person asked for themselves (sign-in,
  // password reset) belong to a global account with no one firm, and stay UTC.
  const IN_INDIA = "2 September 2026, 19:35 India Standard Time";

  it("puts the portal invite's expiry on the firm's clock", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite("meera@cobaltfoods.in", URL, EXPIRES, "10x Global", "Asia/Kolkata");
    expect(only(t).text).toContain(IN_INDIA);
    expect(only(t).html).toContain(IN_INDIA);
    expect(only(t).text).not.toContain("UTC");
  });

  it("and the staff welcome's, and the portal welcome's", () => {
    const staff = new Captured();
    void new SmtpMailer(staff).sendStaffWelcome("priya@10xglobal.in", URL, EXPIRES, "10x Global", "Asia/Kolkata");
    expect(only(staff).text).toContain(IN_INDIA);
    const portal = new Captured();
    void new SmtpMailer(portal).sendPortalWelcome("meera@cobaltfoods.in", URL, EXPIRES, "10x Global", "Asia/Kolkata");
    expect(only(portal).text).toContain(IN_INDIA);
  });

  it("says UTC, as before, when the firm's zone is not known", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendStaffWelcome("priya@10xglobal.in", URL, EXPIRES, "10x Global");
    expect(only(t).text).toContain("2 September 2026, 14:05 UTC");
  });
});

describe("a letter sent for a firm comes FROM the firm, by name (audit 2026-10-03, CA#12)", () => {
  // A client of Sharma Mehta & Co was invited to its portal by "10x Global":
  // the deployment's one BIB_MAIL_FROM_NAME, which is another CA firm's name.
  // The proposal already went out under the firm's own (0085). Every letter
  // a firm sends now does; only the display name moves, never the address
  // the relay authenticates. The two a person asked for themselves (sign-in,
  // password reset) belong to an account with no one firm, and keep the
  // deployment's.
  const FIRM = "Sharma Mehta & Co";

  it("the portal invite, the staff welcome and the portal welcome", () => {
    const invite = new Captured();
    void new SmtpMailer(invite).sendPortalInvite("anil@deccanagro.in", URL, EXPIRES, FIRM);
    expect(only(invite).fromName).toBe(FIRM);
    const staff = new Captured();
    void new SmtpMailer(staff).sendStaffWelcome("sneha@sharmamehta.in", URL, EXPIRES, FIRM);
    expect(only(staff).fromName).toBe(FIRM);
    const portal = new Captured();
    void new SmtpMailer(portal).sendPortalWelcome("anil@deccanagro.in", URL, EXPIRES, FIRM);
    expect(only(portal).fromName).toBe(FIRM);
  });

  it("keeps the deployment's name when the firm's is not known, rather than inventing one", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendPortalInvite("anil@deccanagro.in", URL, EXPIRES, null);
    expect(only(t).fromName).toBeUndefined();
  });

  it("a name that could add a header is cleaned before it is the sender", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendStaffWelcome("sneha@sharmamehta.in", URL, EXPIRES, "Sharma\r\nBcc: x@evil.test");
    expect(only(t).fromName).not.toMatch(/[\r\n]/);
  });

  it("the weekly advances summary to the firm's administrator", () => {
    const t = new Captured();
    void new SmtpMailer(t).sendAdvanceDigest({
      to: "rajesh@sharmamehta.in",
      recipientName: "Rajesh Sharma",
      firmName: FIRM,
      weekOf: "2026-09-28",
      advancesUrl: "https://app.example.com/invoices/advances",
      rows: [],
    });
    expect(only(t).fromName).toBe(FIRM);
  });

  it("the sign-in link and the password reset keep the deployment's name", () => {
    const signIn = new Captured();
    void new SmtpMailer(signIn).sendMagicLink("anil@deccanagro.in", URL, EXPIRES);
    expect(only(signIn).fromName).toBeUndefined();
    const reset = new Captured();
    void new SmtpMailer(reset).sendPasswordReset("anil@deccanagro.in", URL, EXPIRES);
    expect(only(reset).fromName).toBeUndefined();
  });
});
