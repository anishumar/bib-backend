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
