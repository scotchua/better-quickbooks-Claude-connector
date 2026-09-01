# Security — Questions and Answers

This app can read and change real QuickBooks data. That is a big deal. Here are
the common safety questions, answered in plain words.

## What secret things does this app keep?

Two kinds:

- **Your keys** — the Client ID and Secret from Intuit. They live in a file
  called `.env`.
- **Your tokens** — special passes that let the app open your books without your
  password each time. They live in files named `tokens.json` or
  `tokens.<nickname>.json`, one per company. Interrupted OAuth work can also
  leave an encrypted `.qbo-token-stage-<nickname>.json`,
  `.qbo-refresh-recovery-<nickname>.json`, or
  `.qbo-disconnect-recovery-<nickname>.json` file. These are deliberate recovery
  journals, not disposable temp files: rerunning the corresponding command
  either completes the local operation or fails closed with recovery guidance.

Anyone who gets these could reach your books. So we keep them off the internet.

The accounting data returned by tools is different: it is delivered to the MCP
client and AI model you chose so the model can answer. This repository operates
no hosted relay or shared database, but you still need to evaluate that AI
provider's privacy, retention, and client-authorization terms for real books.

## Are these secrets shared when I put the code online?

No. The app has a list called `.gitignore`. Files on that list are never saved to
GitHub. The list includes `.env`, **every** canonical token file (the rule is
`tokens*.json`), and every encrypted OAuth staging/recovery journal. Your
exported reports folder and other extras are on the list too.

When someone downloads this project, they get **no** secrets. They add their own
keys and connect their own QuickBooks.

## What if a secret gets shared by mistake?

Treat it like a lost house key: change the locks.

1. If a company token may have leaked, run `npm run disconnect -- <nickname>`
   for that company to revoke the Intuit grant. Repeat for every affected
   company.
2. If the app's Client Secret may have leaked, rotate it in the Intuit developer
   portal and update `.env`.
3. Re-authorize only the companies that still need access, using the documented
   sandbox or production flow.

After that, the leaked secret no longer works.

## How does the connector prevent one company's data mixing with another's?

Each company has its own token file. Every response includes company provenance,
and writes require the company slug on the call itself by default. The connector
also remembers whether each company is sandbox or production and selects the
matching API host. These controls turn a missing, unknown, or malformed target
into an error; operators should still verify the named company before approving
a real write.

## Can it change the wrong company's books by accident?

We built a safety gate to stop that.

- Every action can take a company name.
- You can also set an active company first, so you don't repeat yourself for
  **reads**.
- For anything that **changes** your books (like making an invoice or a journal
  entry), the app will **not guess** the company, and by default it will not use
  the active company either. You have to name the company on the call itself. If
  you didn't, it stops and asks. Only harmless "read" actions may assume the
  company when there is just one.

Why writes are stricter: one copy of this app serves every Claude conversation
you have open at once, so the "active company" is shared between them. If a
write could inherit it, picking a client in one chat could redirect a write you
made in another. Requiring the name on the write itself removes that path.

If you turn that off (`QBO_REQUIRE_EXPLICIT_COMPANY=false`), writes go back to
using the active company, and the shared-setting problem above comes back with
them. That is a reasonable trade if you only ever have one chat open.

## Do the tokens expire?

Yes, and that is good. The app refreshes them on its own before they run out. If
Intuit reports that one fully expired, re-authorize with the flow for
that environment: `QBO_COMPANY=<slug> npm run connect -- --replace-existing`
for sandbox, or `npm run connect:playground -- <slug> --replace-existing` (or
your configured HTTPS catcher with that flag) for production. Localhost
authorization is not a production recovery path. Replacement also refuses a
different realm or environment, even when the flag is present.

Before sending a refresh request, the connector fsyncs an encrypted recovery
journal. After a successful response, it fsyncs Intuit's complete successor
token into that journal before replacing the canonical token file. A process
crash or disk failure can therefore be recovered locally without resending the
old refresh token. If the token endpoint outcome is ambiguous (for example a
timeout, HTTP 408, or HTTP 5xx), the journal remains quarantined and every later
process refuses to replay it; reconnecting replaces that uncertain grant.

Disconnect uses a separate encrypted journal when more than one canonical,
Playground-stage, or refresh-recovery credential may exist. It attempts each
distinct credential and remembers confirmed revocations, so a later retry does
not resend one that already succeeded. Local credential files are removed only
after every relevant revocation is confirmed; ambiguous revocations require
manual Intuit app-connection review.

## Could my tokens show up in a log or a screen somewhere?

The app writes its notes to a hidden channel, not the main output, and it never
prints your tokens there.

One deliberate exception: the command `node src/index.js --access-token <name>`
prints a one-hour access token, because its whole job is to hand that token to
another program on your computer (the reporting scripts use it, so that only one
program ever renews your login). It is not used during normal Claude work, every
use is written to the optional accountability log when that log is enabled, and
the long-lived refresh token is never printed.

## Is every change really written down?

Yes, at the recovery layer. Before a write is sent, the connector fsyncs a
body-free intent to `audit-log/write-recovery.jsonl`. It records the company,
realm, environment, method, complete request path, one-time request id, and a
SHA-256 payload fingerprint. If that intent cannot be made durable, the request
is **not sent**. A success, API rejection, unreadable response, or transport
failure is appended afterward. This ledger stays enabled even when
`QBO_AUDIT=off`, because safe retry depends on it.

Use the read-only `list_unresolved_writes` tool to see only requests whose
latest outcome is still ambiguous. After checking QuickBooks, a single-request
tool can accept that `request_id` with the same arguments only while the queue
marks it `replay_eligible`; the connector verifies both the durable fingerprint
and its conservative age limit. Intuit publishes no retention guarantee for
request ids, so an older ambiguous write is reconciliation-only even though its
id stays permanently reserved locally. Composite workflows do not accept generic replay;
use their dedicated resume/reconciliation path or a single-record tool so an
earlier success cannot be repeated. The connector refuses a changed payload,
company, realm, environment, method, or endpoint, and never exposes the
original request body from the ledger.

There is also a human-facing monthly accountability log with the tool name,
Intuit trace id, and response summary. `QBO_AUDIT=off` may disable that optional
log; `QBO_AUDIT=strict` makes a failure to append it visible. If QuickBooks has
already completed the action, no local logging mode can roll it back.

## What is the difference between "sandbox" and "production"?

- **Sandbox** = a fake, practice company from Intuit. Safe to play in. Nothing is
  real.
- **Production** = your real books. Changes here are real. Money, invoices, and
  bills are the actual ones.

Before approving any action that changes things, verify the explicit company
slug and whether it is production. The active-company setting is only a reading
convenience and is not authority for a write by default.
