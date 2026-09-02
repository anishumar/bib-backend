// The vendor half — nodemailer actually talking to a relay.
//
// `letters.test.ts` reads what a client receives and never touches a socket,
// which is right: the words are the part with judgement in them. This file
// proves the other half, and it is the half that fails silently in the way this
// codebase keeps rediscovering — `::text::jsonb` typechecked, linted, passed
// every unit test against a fake, and died on the first real statement. A mail
// transport is the same shape of risk: a misconfigured `auth` block, a From
// header the library builds differently than expected, a body that never
// becomes MIME. **If you add a transport, send through it.**
//
// It runs against a THROWAWAY SMTP server on 127.0.0.1, spoken here in about
// forty lines. Nothing leaves the machine and no external service is involved —
// a hosted catcher would have made the suite depend on somebody's uptime and an
// account, to prove a property that is entirely local.
//
// It is an INTEGRATION test rather than a unit one for the reason the config
// draws that line: it binds a real socket. It needs no database.
//
// Run with:  npm run test:integration
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodemailerTransport } from "../../src/infrastructure/mail/nodemailer-transport";
import { SmtpMailer } from "../../src/infrastructure/mail/smtp-mailer";
import type { Logger } from "../../src/platform/log";

/** Enough SMTP to accept a message and hand back what arrived. */
function catcher(): { server: net.Server; received: string[] } {
  const received: string[] = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let message = "";
    sock.write("220 localhost ESMTP throwaway\r\n");
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const i = buf.indexOf("\r\n");
        if (i === -1) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(message);
            message = "";
            sock.write("250 2.0.0 Ok: queued\r\n");
          } else {
            // A leading dot is stuffed by the sender; unstuff it.
            message += (line.startsWith("..") ? line.slice(1) : line) + "\n";
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        // STARTTLS is deliberately NOT advertised: a self-signed certificate
        // would need the client to be told to trust it, which is a setting this
        // test must not teach anybody to add.
        if (verb === "EHLO" || verb === "HELO") sock.write("250-localhost\r\n250 SIZE 10485760\r\n");
        else if (verb === "MAIL" || verb === "RCPT") sock.write("250 2.1.0 Ok\r\n");
        else if (verb === "DATA") {
          inData = true;
          sock.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          sock.write("221 2.0.0 Bye\r\n");
          sock.end();
        } else sock.write("250 2.0.0 Ok\r\n");
      }
    });
    sock.on("error", () => undefined);
  });
  return { server, received };
}

const silent: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as unknown as Logger;

const { server, received } = catcher();
let port = 0;

function mailerOn(p: number): SmtpMailer {
  return new SmtpMailer(
    new NodemailerTransport(
      { host: "127.0.0.1", port: p, secure: false, user: null, password: null },
      { address: "no-reply@10xglobal.in", name: "10x Global" },
      silent,
    ),
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

describe("a letter handed to a real relay", () => {
  it("arrives as a MIME message with both bodies", async () => {
    await mailerOn(port).sendPortalInvite(
      "meera@cobaltfoods.in",
      "https://app.10xglobal.in/portal/accept-invite?token=abc123",
      "2026-09-04T14:05:00.000Z",
      "10x Global",
    );
    const raw = received.at(-1);
    expect(raw).toBeDefined();
    if (raw === undefined) return;

    // The headers a mail client reads, and the ones a spam filter scores.
    expect(raw).toContain("From: 10x Global <no-reply@10xglobal.in>");
    expect(raw).toContain("To: meera@cobaltfoods.in");
    expect(raw).toContain("Subject: 10x Global has invited you to their client portal");
    // Both bodies, in one message, as alternatives — which is what makes the
    // plain-text half a real half rather than a comment nobody sends.
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("text/plain");
    expect(raw).toContain("text/html");
  });

  it("sends with no auth block when the relay takes no login", async () => {
    // `null` user and password are a real configuration — a relay on a private
    // network may accept mail from this host with no login — and the adapter
    // omits the `auth` key entirely rather than passing an empty one, which
    // nodemailer would try to authenticate with and be rejected for. The proof
    // is simply that the send above succeeded against a server advertising no
    // AUTH at all.
    const before = received.length;
    await mailerOn(port).sendMagicLink(
      "siddharth@10xglobal.in",
      "https://app.10xglobal.in/auth/magic-link?token=xyz789",
      "2026-09-02T14:35:00.000Z",
    );
    expect(received.length).toBe(before + 1);
  });

  it("REJECTS when the relay is unreachable, which is what the swallow rests on", async () => {
    // `IdentityService.requestMagicLink` swallows this deliberately, so that a
    // failed send cannot be told apart from an unknown account. That decision
    // is only safe if a failure genuinely surfaces HERE — a transport that
    // resolved on failure would make the swallow moot and the log line never
    // fire. Port 1 is reserved and nothing listens on it.
    await expect(
      mailerOn(1).sendMagicLink("nobody@example.com", "https://x/y", "2026-09-02T14:35:00.000Z"),
    ).rejects.toThrow();
  });
});
