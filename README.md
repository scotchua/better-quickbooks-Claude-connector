# Better QuickBooks Connector

Connect Claude Desktop straight to **QuickBooks Online** — and work in **all your
companies from one connector**, not one at a time. Read *and* write.

Built on the [Model Context Protocol](https://modelcontextprotocol.io).
Originally built by Opzer.

## Who this is for

This is for **accountants and bookkeepers** who use QuickBooks Online for more
than one company and want Claude to help with real work — pulling reports,
cleaning up the books, sending invoices, and entering transactions.

The QuickBooks connector that comes built into Claude is aimed at a different
job. It launched read-only, and Intuit has since been adding specific actions to
it (invoicing, payroll lookups), but it is built for a small business looking at
**its own** books:

- It covers a **narrow slice** of QuickBooks. Fine for "how did we do last
  month" and a few common actions; not the full ledger a bookkeeper works in.
- It points at **one company at a time.** If you handle 5, 20, or 50 client
  files, switching back and forth gets slow and clumsy.

This tool is built for the other end of that:

- **Many companies, one connector.** Connect all your client files once. Then
  just tell Claude which one to use — *"work on Acme."* No switching connectors,
  no restarts. Anything that *changes* the books names its company on the
  request itself, so a write can never inherit the wrong one.
- **The whole ledger, read *and* write.** Invoices, bills, journal entries,
  bill payments, deposits, transfers, credit memos, the chart of accounts, class
  and location tagging — the things you actually do in QuickBooks all day, not a
  handful of common ones.
- **114 tools** covering reports, transactions, searches with typed filters,
  bill payments, invoice and estimate PDFs, attachments, change tracking,
  reconciliation, side-by-side multi-company reporting, diagnostics, and a safe
  bulk CSV import. Connecting a new client happens in the chat: Claude hands you an
  Intuit link, you click Allow, and it confirms which company landed.

You do **not** need to know how to code. The setup below is copy-and-paste.

> 👉 **Prefer an even simpler walkthrough?** See
> **[SETUP_GUIDE.md](SETUP_GUIDE.md)** — the same process boiled down to just
> telling Claude Code *"help me install this for N clients"* and pasting your keys.

## What you can do

- **Pull reports:** Profit & Loss, Balance Sheet, Cash Flow, Trial Balance,
  General Ledger, A/R and A/P aging, overdue invoices. Every report tool takes an
  optional `save_path`: name one and the JSON is written to that file and you get
  back a one-line receipt naming the window, basis and breakdown, instead of the
  whole payload. An 18-month monthly P&L runs past 150KB, so anything a script is
  going to read belongs in a file, and the file doubles as the dated artifact the
  downstream work cites.
- **Enter and edit work:** customers, vendors, items, accounts, invoices, bills,
  bill payments, transfers, expenses, estimates, sales receipts, credit memos,
  payments, deposits, and journal entries, with class, location, and sales-tax
  tagging on line items.
- **Speed up month-end:** import a bank CSV (with a preview first, sign-aware,
  and safe to re-run), attach source documents, run collections, and pull
  "what changed since" reports for any entity.
- **Work across clients:** switch between companies in one connector, or name one
  per request. Put several named clients' P&L or Balance Sheet side by side in one
  table with a combined column, or post the same journal entry (like a monthly
  management fee) to many files in one call. The multi-company reports are an
  arithmetic combination, not an accounting consolidation: no eliminations, no
  ownership test, and rows only merge where account names match. You name the
  companies; there is no "everything at once" default, and mixing home currencies
  is refused rather than silently summed.
- **Review the books:** reconcile a bank statement against the register, scan
  for duplicate transactions, and pull a flat general ledger with review flags
  (weekend postings, large or round amounts, journal entries).

---

## Security — what we did to keep your books safe

This app can change **real** accounting data, so safety was built in from the
start. Here are the protections that matter, in plain words. (For the technical
detail behind each, see [SECURITY.md](SECURITY.md) and
[DEVELOPER.md](DEVELOPER.md).)

### It all runs on your own computer

This is the biggest one, and the foundation for the rest. This app is
**local** — it lives on your own computer (Mac or Windows). There is **no
website or cloud server in the
middle**, and nothing to sign up for. The app only ever talks straight to
QuickBooks (Intuit). That means:

- Your keys and login passes **never leave your computer** (except to reach
  QuickBooks itself). You never upload them, and you never share them with us or
  any third party — there is no "us."
- There is **no online service to break into.** No shared database of client
  books sitting on someone else's server.
- You are in full control. If you delete the folder, everything — keys, tokens,
  access — is gone with it.

### Keeping companies from getting mixed up

- **Writes name their own company. Always.** For reading, you can set an active
  company with **`select_company`** and then just talk (check it with
  **`get_active_company`** or **`list_companies`**). For anything that
  **changes** your books — an invoice, a bill, a journal entry — that is not
  enough: the company has to be named on the request itself, or the app stops
  and asks.

  The reason is that one copy of this app serves **every Claude conversation you
  have open at once**, so the "active company" is shared between them. If a write
  could inherit it, picking a client in one chat could redirect a write you made
  in another. Requiring the name on the write removes that path entirely. (If you
  only ever have one chat open and prefer the old behaviour, set
  `QBO_REQUIRE_EXPLICIT_COMPANY=false` in `.env`.)
- **Only real company names are accepted.** If you name a company that is not
  connected, the app refuses and shows you the list of ones that are.
- **A misspelled company name is an error, not a guess.** Names may contain only
  letters, numbers, dashes, and underscores. Anything else is rejected outright
  rather than quietly cleaned up, because "acme!" silently becoming "acme" is how
  a typo ends up posting to a real client's books.
- **Test books and real books can use different keys.** Intuit issues separate
  development and production keys, and each only works against its own side. If
  you run sandbox files alongside real ones, set both pairs in `.env` and the app
  picks the right one per company.
- **Test books and real books stay apart.** Each company remembers whether it is
  a **test (sandbox)** or **real (production)** file, and every request is sent
  to the matching QuickBooks address. A test action cannot hit real books.

### Keeping your secrets safe

- **Secrets never go online.** Your keys (`.env`) and your login passes
  (`tokens*.json`) are on the "never upload" list (`.gitignore`). When someone
  downloads this project, they get **no** secrets — they add their own.
- **Secrets stay on your computer.** Your keys and tokens are only ever sent to
  Intuit (QuickBooks). They are not shared with anyone else.
- **Keys are not baked into the code.** They are read from your private `.env`
  file, so the code can be shared safely.
- **Secrets never show up in logs.** The app writes its notes to a hidden channel
  (not the main output), and it never prints your keys or tokens.
- **Login passes are scrambled on disk.** Each company's tokens are encrypted
  (AES-256-GCM) before they are saved. The unlock key lives in your Mac's
  Keychain or Windows protected storage, so a copied token file is useless on
  its own. Offboarding a client? `npm run disconnect -- <nickname>` revokes the
  access with Intuit and removes the file.
- **Changes are written down.** Each action that changes your books is recorded
  in a local log (`audit-log/`) with the tool that ran, the company, and
  Intuit's trace id, so you can answer "what did Claude post, and when." If the
  log itself cannot be written the accounting action still goes through and the
  problem is reported to the log channel; `QBO_AUDIT=strict` turns that into a
  visible error instead (see SECURITY.md). Writes dated into a closed period
  come back with a warning, including edits to transactions already sitting in
  a closed period.

### Keeping the login safe

- **A tamper check on every login.** Each login uses a one-time random code. If
  the code that comes back does not match, the app rejects it. This blocks a
  common web trick.
- **The "catcher" only listens on your own computer.** During login, the app
  opens a tiny helper at `localhost:3000` — *your* machine only — just long
  enough to catch the pass, then it shuts down.
- **That catcher is picky.** It answers only the exact login address and turns
  everything else away.
- **Logins refresh on their own.** Passes renew automatically before they run
  out. If one fully expires (about 100 days unused), you just log in again.

### Keeping changes from going wrong

- **Preview before you post, and it is not optional.** The bank-CSV import
  **requires** a `dry_run` of that exact file against that exact account first.
  The preview shows every row and the category it guessed; only after you have
  seen it will the live import run. Categorization is a keyword match, so the
  dry run is the step where a human catches a mis-filed expense.
- **Re-running an import cannot double-post.** Every imported row is stamped
  with a marker in its QuickBooks memo, and the app keeps a local journal of what
  it sent. If it is interrupted part-way, the next run asks QuickBooks which rows
  actually landed instead of assuming, and skips those.
- **A write that times out is not repeated blindly.** Each change carries a
  one-time id that Intuit recognizes, so a lost reply can be re-sent safely
  instead of creating a second invoice.
- **The guardrail file fails closed.** If `qbo-policy.json` is unreadable or has
  a typo in it, the app refuses to write at all rather than treating "cannot read
  the rules" as "there are no rules."
- **Local files stay where you put them.** Set `QBO_FILES_DIR` in `.env` (the
  firm's client-files root, e.g. `~/Claude`) and every file the app reads or
  writes must live inside that folder. Shortcuts and symlinks are resolved before
  the check, so a link inside the folder cannot reach outside it, and files whose
  names look like credentials are refused everywhere. Attaching a document to a
  QuickBooks record **requires** this to be set, because that file leaves your
  computer.
- **Saving a file will not silently replace one.** Downloaded PDFs and
  attachments refuse to overwrite an existing file unless you say so.
- **Errors are handled cleanly.** If a request fails, the app returns a clear
  message instead of crashing, so nothing is left half-done.

For a friendly Q&A version of all this, see [SECURITY.md](SECURITY.md).

> ⚠️ Before you connect a **real (production)** company, read the security notes
> above. Never share your `.env` or `tokens*.json` files.

---

## Step-by-step setup (no coding experience needed)

This takes about 20 minutes. You will copy and paste a few commands. You do not
need to understand them — just follow along in order.

**Before you start, you need:**
- A **Mac or a Windows PC**.
- The QuickBooks Online login for the company you want to connect.
- [Claude Desktop](https://claude.ai/download) installed.
- About 20 minutes.

**Step 1 — Install Node (the engine this app runs on).**
Go to [nodejs.org](https://nodejs.org), click the big button that says **LTS**,
and run the file it downloads (a `.pkg` on Mac, a `.msi` on Windows). Click
"Continue" / "Next" until it finishes. The LTS button gives you a new enough
version; this app needs **Node 22 or newer**. If you already have Node and are
not sure, run `node --version`.

**Step 2 — Download this project.**
On this page, click the green **Code** button, then **Download ZIP**. Unzip it
(Mac: double-click it; Windows: right-click → **Extract All**), and put the
`qbo-mcp-server` folder on your **Desktop**.

**Step 3 — Open a command window.**
- **Mac:** Press `Cmd + Space`, type `Terminal`, and press Enter.
- **Windows:** Press the `Windows` key, type `PowerShell`, and press Enter.

A window with a blinking cursor opens — this is where you paste commands. Paste
the line **for your system** and press Enter:

Mac:
```bash
cd ~/Desktop/qbo-mcp-server && npm install
```
Windows (PowerShell):
```powershell
cd $HOME\Desktop\qbo-mcp-server; npm install
```
This moves into the folder and downloads the parts the app needs. Wait for it to
finish (a minute or two).

**Step 4 — Get your QuickBooks keys.**
The app needs two secret keys from Intuit (the company that makes QuickBooks) so
it can talk to your books.
1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in with
   your Intuit account.
2. Create a new app, and choose the **Accounting** scope.
3. Find the **Keys & OAuth** page. Copy the **Client ID** and **Client Secret**.
4. On that same page, add this exact **Redirect URI**:
   `http://localhost:3000/callback`

**Step 5 — Put your keys into the app.**
Make your settings file and open it. Paste the line **for your system**:

Mac:
```bash
cp .env.example .env && open -e .env
```
Windows (PowerShell):
```powershell
copy .env.example .env; notepad .env
```
A text window opens. Paste your Client ID after `QBO_CLIENT_ID=` and your Client
Secret after `QBO_CLIENT_SECRET=`.

While you are in there, find the line `# QBO_FILES_DIR=~/Claude`, remove the
leading `# `, and set it to the folder where your client files live. This fences
every file the app reads or writes into that one folder, and attaching documents
to QuickBooks records will not work without it. Save and close the window.

**Step 6 — Connect a company.**

> **Real client books?** Use this instead, then skip to Step 7:
> ```bash
> npm run connect:playground -- acme
> ```
> Intuit only accepts `localhost` as a redirect for its *test* companies, so the
> command below works for sandbox files only. The playground flow gets you a real
> company in about two minutes: it opens Intuit's own OAuth 2.0 Playground, you
> pick your app and the company and click Allow, then paste back the **Realm ID**
> and **Refresh Token** it shows you (your typing stays hidden). One-time setup:
> on your app's **Production** Keys & OAuth page, add this Redirect URI exactly:
> `https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`
>
> Nothing to host, and no third-party page in the middle. (There is a second
> production option, `npm run connect:catcher`, for a one-paste redirect flow
> against a page you host yourself; see `docs/oauth-catcher/`.)

For an Intuit **sandbox** test company, pick a short nickname (letters/numbers
only, e.g. `acme`) and paste the line **for your system**, replacing `acme` with
your nickname:

Mac:
```bash
QBO_COMPANY=acme npm run connect
```
Windows (PowerShell):
```powershell
$env:QBO_COMPANY="acme"; npm run connect
```
Your web browser opens. Log in to the QuickBooks company and click **Allow**.
When you see "✅ QuickBooks connected," close that browser tab. Repeat this step
for each company you want to add (use a different nickname each time).

**Adding many companies at once?** Use the batch tool — log in once, then just
pick + Allow each company. **Same command on Mac and Windows:**
```bash
npm run connect:batch                 # keeps asking "add another?"
npm run connect:batch -- --count 50   # or do a set number in a row
```

**Step 7 — Tell Claude Desktop about the app (once, ever).**
The easiest way is to let Claude do it for you: open **Claude Code** and type
`/add-qbo-company`, then follow the prompts. It registers a single **`qbo`**
connector that serves every company you connect, now or later, and checks that
it worked. (If you'd rather do it by hand, see *Setup (quick reference)* in
DEVELOPER.md.) After this one-time step, adding more companies needs no restart.

> **Both values in `claude_desktop_config.snippet.json` are placeholders.** They
> are specific to your machine, and copying them as-is fails with "server
> disconnected." Find yours:
>
> | Field | How to find it | Why it differs per machine |
> |---|---|---|
> | `command` | `which node` (Mac) or `where node` (Windows) | nvm, Homebrew, Volta, and system Node all install elsewhere |
> | `args[0]` | run `pwd` in this folder, then add `/src/index.js` | depends where you unzipped it |
>
> Both must be **absolute**. A bare `"node"` fails, because Claude Desktop starts
> the server without your shell's `PATH`. On Windows, double every backslash in
> JSON. If your download produced a folder like `...-main-2`, or you renamed it,
> the path has to match the folder that actually exists. Restart Claude Desktop
> fully after editing.
>
> **Setting this up with Claude?** Tell it to run `which node` and `pwd` here and
> use those results. An assistant that reuses the placeholder paths, or paths it
> saw in these docs, produces a config that cannot start.

**Step 8 — Restart Claude Desktop.**
- **Mac:** Quit Claude Desktop completely (`Cmd + Q`), then open it again.
- **Windows:** Right-click the Claude icon in the **system tray** (bottom-right,
  by the clock), choose **Quit**, then open it again. Just closing the window
  isn't enough — it keeps running in the tray.

Your companies now appear, and you can ask things like *"list my QuickBooks
companies"* or *"show me last month's profit and loss for acme."*

**Step 9 — Set tool permissions (recommended).**
In Claude Desktop, open **Settings → Connectors**, click a `qbo-…` connector, and
you'll see its **Tool permissions**. This controls when Claude acts on its own
versus asking you first.

![QuickBooks connector tool permissions in Claude Desktop](docs/images/tool-permissions.png)

Each tool can be set to **Always allow** (✓), **Needs approval** (✋), or **Never**
(⛔). Every tool tells Claude Desktop whether it only reads, whether it destroys
anything, and whether running it twice is safe, so the list should already sort
sensibly. Our recommendation:

- **Read-only tools → Always allow.** They only *look* at the books, so letting
  them run freely keeps Claude fast. Examples: *List companies, Get profit and
  loss, Get balance sheet, Get cash flow, Get aged receivables, Get invoices.*
- **Write tools → Needs approval.** They *change* the books, so keep a human in
  the loop — Claude pauses and asks before each. Examples: *Create invoice, Create
  bill, Create bill payment, Create journal entry, Send invoice email, Void
  invoice, Import transactions from CSV.*
- **The two escape hatches differ:** `api_get` only reads, so it can be Always
  allow. `api_request` can post anything to QuickBooks; keep it on **Needs
  approval** (or Never).
- **Firm-wide off switches:** set `QBO_DISABLE_WRITES=true` in `.env` and the
  write tools are never registered at all (a read-only deployment for review
  staff), or `QBO_DISABLE_DELETES=true` to hide just deletes and voids.

You get quick answers on anything that just reads, and a confirmation step on
anything that posts. Repeat for each client connector.

Stuck on a step? Just tell Claude Code what happened — it can re-check the
connection, re-authorize a company, or add another one for you.

> **Testing:** see **[TESTING.md](TESTING.md)** for a staged verification checklist (automated, sandbox, production pilot).
>
> **Developers:** technical setup, the full tool list, and architecture live in
> **[DEVELOPER.md](DEVELOPER.md)**.

## Help & support

Stuck on a step or seeing an error? Tell Claude (Code or Desktop) exactly what
happened. It can re-check the connection, re-authorize a company, or walk the
setup again with you. The `health_check` tool is the fastest first step: it
verifies every connected company's tokens and API access in one call.

---

## License and lineage

Apache License 2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)), the same
license as Intuit's official
[quickbooks-online-mcp-server](https://github.com/intuit/quickbooks-online-mcp-server),
whose design patterns this project adopted. The original connector was built
by Isaac (Opzer) and is extended here with his permission.

Fork it, modify it, run it at your firm. If you make it better, please send
the improvement back as a pull request or an issue (see
[CONTRIBUTING.md](CONTRIBUTING.md)) so every firm using it benefits.
