// The notification email (0324), read rather than assumed: what a colleague
// receives, at once or once a day.
import { describe, expect, it } from "vitest";
import { SmtpMailer } from "../../src/infrastructure/mail/smtp-mailer";
import type { Letter, MailTransport } from "../../src/infrastructure/mail/smtp-mailer";
import type { NotificationLetter } from "../../src/usecase/notify/ports";

class Captured implements MailTransport {
  readonly sent: Letter[] = [];
  send(letter: Letter): Promise<void> {
    this.sent.push(letter);
    return Promise.resolve();
  }
}

function send(letter: Partial<NotificationLetter>): Letter {
  const t = new Captured();
  void new SmtpMailer(t).sendNotifications({
    to: "asha@firm.example",
    recipientName: "Asha",
    firmName: "Kaveri & Co",
    mode: "digest",
    items: [
      { title: "Pat gave you a task", detail: "GST return · Kaveri Foods", url: "https://app.example/work-items/1" },
      { title: "A bill is ready to raise", detail: null, url: "https://app.example/invoices?tab=raise" },
    ],
    inboxUrl: "https://app.example/notifications",
    settingsUrl: "https://app.example/account",
    ...letter,
  });
  const [sent] = t.sent;
  if (sent === undefined) throw new Error("nothing was sent");
  return sent;
}

describe("the daily email", () => {
  it("names the count and the firm in the subject", () => {
    expect(send({}).subject).toBe("2 unread notifications · Kaveri & Co");
  });

  it("links every notification, the list, and where to switch these emails off", () => {
    const l = send({});
    for (const url of ["https://app.example/work-items/1", "https://app.example/notifications", "https://app.example/account"]) {
      expect(l.text).toContain(url);
      expect(l.html).toContain(url);
    }
    expect(l.text).toContain("Choose which emails you get");
  });

  it("escapes the firm's name and the words in HTML", () => {
    const l = send({ items: [{ title: "<b>x</b>", detail: "a & b", url: "https://app.example/x" }] });
    expect(l.html).toContain("Kaveri &amp; Co");
    expect(l.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(l.html).not.toContain("<b>x</b>");
  });
});

describe("the urgent email", () => {
  it("puts a single notification's own words in the subject", () => {
    const l = send({
      mode: "instant",
      items: [{ title: "A filing deadline was missed", detail: "GSTR-3B Sep 2026", url: "https://app.example/calendar" }],
    });
    expect(l.subject).toBe("A filing deadline was missed · Kaveri & Co");
    expect(l.text).toContain("needs your attention");
  });

  it("cannot be given a header through a firm's name", () => {
    const l = send({ mode: "instant", firmName: "Evil\r\nBcc: x@y.z" });
    expect(l.subject).not.toMatch(/[\r\n]/);
  });
});
