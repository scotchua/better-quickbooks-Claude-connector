# Security — Questions and Answers

This app can read and change real QuickBooks data. That is a big deal. Here are
the common safety questions, answered in plain words.

## What secret things does this app keep?

Two kinds:

- **Your keys** — the Client ID and Secret from Intuit. They live in a file
  called `.env`.
- **Your tokens** — special passes that let the app open your books without your
  password each time. They live in files named `tokens.json` or
  `tokens.<nickname>.json`, one per company.

Anyone who gets these could reach your books. So we keep them off the internet.

## Are these secrets shared when I put the code online?

No. The app has a list called `.gitignore`. Files on that list are never saved to
GitHub. The list includes `.env` and **every** token file (the rule is
`tokens*.json`, which covers all of them, not just one). Your exported reports
folder and other extras are on the list too.

When someone downloads this project, they get **no** secrets. They add their own
keys and connect their own QuickBooks.

## What if a secret gets shared by mistake?

Treat it like a lost house key: change the locks.

1. Go to the Intuit developer site and make a new Client Secret (this turns off
   the old one).
2. Run `npm run connect` again to get fresh tokens.

After that, the leaked secret no longer works.

## Can one company's data mix with another company's?

No. Each company has its own token file. When the app makes a request, it picks
the right file for that one company. It also knows whether each company is a test
(sandbox) or a real (production) company, so requests can't go to the wrong place.

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
they ever fully expire (about 100 days unused), you just run `npm run connect`
again.

## Could my tokens show up in a log or a screen somewhere?

The app writes its notes to a hidden channel, not the main output, and it never
prints your tokens there.

One deliberate exception: the command `node src/index.js --access-token <name>`
prints a one-hour access token, because its whole job is to hand that token to
another program on your computer (the reporting scripts use it, so that only one
program ever renews your login). It is not used during normal Claude work, every
use is written to the audit log, and the long-lived refresh token is never
printed.

## Is every change really written down?

Nearly. Each action that changes your books is appended to a local log in
`audit-log/`, with the tool that ran, which company, Intuit's trace id, and what
came back. Two honest caveats:

- If that log **cannot be written** (bad folder, disk full), the accounting
  action still goes through and the problem is reported to the hidden channel.
  Setting `QBO_AUDIT=strict` turns that into a visible error instead. Even then
  the change has already reached QuickBooks; strict makes the gap loud, it
  cannot undo anything.
- Setting `QBO_AUDIT=off` disables the log entirely.

So the log is complete as long as it is enabled and writable, which is the
normal case, but it is not a guarantee the app can enforce on its own.

## What is the difference between "sandbox" and "production"?

- **Sandbox** = a fake, practice company from Intuit. Safe to play in. Nothing is
  real.
- **Production** = your real books. Changes here are real. Money, invoices, and
  bills are the actual ones.

Before you run any action that changes things, make sure you know which company
is active — especially if it is a production one.
