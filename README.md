# Better QuickBooks Connector

Connect an MCP-capable AI client such as Claude Desktop straight to
**QuickBooks Online** — and work in **all your companies from one connector**,
not one at a time. Read *and* write.

Built on the [Model Context Protocol](https://modelcontextprotocol.io).
Originally built by Opzer.

This is MHPE's local accounting workbench, released free under Apache-2.0 so
other firms can fork and adapt it. There is no hosted service, paid tier, or
shared MHPE data plane; private firm methodology belongs outside this generic
connector.

## Who this is for

This is for **accountants and bookkeepers** who use QuickBooks Online for more
than one company and want Claude to help with real work — pulling reports,
cleaning up the books, sending invoices, and entering transactions.

This connector is deliberately shaped around local, multi-company accounting
work rather than a single-business dashboard:

- **Many companies, one connector.** Connect all your client files once. Then
  just tell Claude which one to use — *"work on Acme."* No switching connectors,
  no restarts. By default, anything that *changes* the books names its company
  on the request itself, so a write cannot inherit the wrong one. Only the
  explicit `QBO_REQUIRE_EXPLICIT_COMPANY=false` compatibility setting opts back
  into inherited write targets.
- **Broad accounting coverage, read *and* write.** Invoices, bills, journal entries,
  bill payments, deposits, transfers, credit memos, the chart of accounts, class
  and location tagging — the core ledger work a bookkeeper does every day, not
  only a handful of common actions.
- **A complete full profile** covering reports, transactions, searches with typed filters,
  bill payments, invoice and estimate PDFs, attachments, change tracking,
  reconciliation, side-by-side multi-company reporting, diagnostics, and a safe
  bulk CSV import. The task-sized default `core` profile keeps the everyday
  reporting, AR/AP, banking, close-review, journal, and explicit-export surface
  focused, and carries every tool the six workflow prompts require so none is
  silently hidden; `accountant` opts into the broad professional surface. Both
  hide OAuth administration, raw API escape hatches, permanent deletion, and
  write-policy editing. Sandbox authorization is
  available in chat under the `admin` profile; real companies use Intuit's
  hosted OAuth Playground or the optional self-hosted HTTPS catcher flow.

As measured on 2026-09-04 by `node scripts/tool-count.js`, the full profile
exposes 118 tools. The script asks the running MCP server for `tools/list` and
prints the sorted names so the documentation can be regenerated.

You do **not** need to know how to code. The setup below is copy-and-paste.

> 👉 **Prefer an even simpler walkthrough?** See
> **[SETUP_GUIDE.md](SETUP_GUIDE.md)** — the same process boiled down to just
> telling Claude Code *"help me install this for N clients"* and pasting your keys.

## What you can do

- **Pull reports:** Profit & Loss, Balance Sheet, Cash Flow, Trial Balance,
  General Ledger, A/R and A/P aging, overdue invoices. These tools are pure
  reads, so hosts can allow them without approving a local file write. When a
  script needs a durable artifact (or a report is too large for inline output),
  call `export_qbo_artifact` explicitly. It writes report JSON or an
  invoice/estimate PDF only inside `QBO_FILES_DIR`, uses private permissions,
  and refuses to replace an existing artifact.
- **Enter and edit work:** customers, vendors, items, accounts, invoices, bills,
  bill payments, transfers, expenses, estimates, sales receipts, credit memos,
  payments, deposits, and journal entries, with class, location, and sales-tax
  tagging on line items.
- **Speed up month-end:** import a bank CSV (with a preview first, sign-aware,
  and duplicate-safe reruns that refuse uncertain rows), attach source
  documents, run collections, and pull
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

### Usability without giving away firm methodology

The public MCP layer now provides three portable kinds of context:

- role-sized tool profiles, so an owner or administrator does not see the full
  accounting/developer surface;
- read-only resources for connected companies, client labels, write policies,
  and per-company capabilities; and
- generic prompts for a month-end data pack, close readiness, business health,
  collections, transaction tracing, and reconciliation. Prompts are advertised
  only when the active profile contains the tools they need.

MCP itself does not standardize a universal "skill" package. Keep MHPE's
specific review thresholds, sequencing, templates, and professional judgment in
the private client-side skills layer. The public connector should remain the
dependable toolbox and generic workflow vocabulary those private skills call.

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
- QuickBooks data returned by a tool is sent to the MCP client and model you
  chose so it can answer you. This repository adds no hosted intermediary, but
  it does not replace your obligation to review that AI provider's privacy,
  retention, and client-authorization terms before using real books.
- There is **no online service to break into.** No shared database of client
  books sitting on someone else's server.
- You are in full control. Run `npm run disconnect -- <nickname>` to revoke an
  Intuit grant, then remove the local folder if desired. Deleting the folder by
  itself removes the local credentials but does not immediately revoke the
  grant already held by Intuit.

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
- **Changes are written down before they leave.** Every write first fsyncs a
  body-free recovery intent containing its company, endpoint, request id, and
  exact payload hash. If that record cannot be written, the QuickBooks request
  is not sent. Outcomes are appended afterward. A separate optional
  accountability record captures the tool, company, and Intuit trace id;
  `QBO_AUDIT=strict` makes a failure there visible. The mandatory recovery
  ledger remains enabled even when the optional audit is off. Writes dated into a closed period
  come back with a warning, including edits to transactions already sitting in
  a closed period. If a posting write omits `TxnDate`, the connector does not
  invent a local UTC date: it warns that QuickBooks server time is
  unverifiable, or refuses the write when `QBO_CLOSED_PERIOD=block`.

### Keeping the login safe

- **A tamper check on every login.** Each login uses a one-time random code. If
  the code that comes back does not match, the app rejects it. This blocks a
  common web trick.
- **The sandbox callback only listens on your own computer.** During a sandbox
  login, the app opens a tiny helper at `127.0.0.1:3000` just long enough to
  receive the callback, then it shuts down. It answers only the exact callback
  path. Production setup instead uses Intuit's Playground or the optional HTTPS
  catcher page described below.
- **Logins refresh on their own.** Passes renew automatically before they run
  out. If Intuit reports that a long-lived refresh token expired, you log in again.

### Keeping changes from going wrong

- **Preview before you post, and it is not optional.** The bank-CSV import
  **requires** `preview_bank_csv_import` on that exact file, company, and account first.
  The preview shows every row and the category it guessed; only after you have
  seen it will the live import run. Categorization is a keyword match, so the
  dry run is the step where a human catches a mis-filed expense.
- **Re-running an import does not guess after an interruption.** Every imported
  row is stamped with a marker in its QuickBooks memo, and the app keeps a local
  journal of what it sent. A rerun skips confirmed rows and heals rows whose
  marker is found in QuickBooks. If an ambiguous row's marker is absent, the
  connector refuses to post it again and requires manual reconciliation; query
  absence is not proof that the first create failed.
- **A write that times out is not repeated blindly.** The outcome is ambiguous:
  inspect QuickBooks and `list_unresolved_writes` first. Single-request tools
  expose a recovery-only `request_id`; the queue marks whether a recent
  unresolved request is still `replay_eligible`, and an identical replay is
  verified against the full durable fingerprint and age limit before sending.
  Intuit publishes no request-id retention guarantee, so the default replay
  ceiling is the 90 seconds actually measured in one sandbox test; older
  ambiguous requests must be reconciled manually. Composite workflows such as bank
  imports and cross-company journals deliberately do not expose blanket replay:
  use their resume journal/result plus dedicated single-record tools, or
  reconcile manually, so earlier successes are never posted again.
  `create_invoice` and `create_bill` each issue exactly one write and support
  this recovery. Email an invoice with `send_invoice_email` afterward; create a
  missing vendor with `create_vendor` before retrying a bill.
- **The guardrail file fails closed.** If `qbo-policy.json` is unreadable or has
  a typo in it, the app refuses to write at all rather than treating "cannot read
  the rules" as "there are no rules."
- **Guardrails protect books, not labels.** Rules are written per company slug,
  but they are resolved per QuickBooks *realm*. If the same company is ever
  reachable under two slugs, every rule set on either one applies, and the
  strictest value wins: read-only on either label makes the books read-only, the
  lowest amount cap applies, and the latest date floor applies. Within a single
  slug a company rule still overrides `defaults`, so the deny-by-default pattern
  (lock everything, reopen one company) keeps working. Authorizing a company
  that is already connected under a different slug is refused outright, and
  `npm run doctor` reports any duplicate that predates that rule.
- **Local files stay where you put them.** Set `QBO_FILES_DIR` in `.env` (the
  firm's client-files root, e.g. `~/Claude`) and every file the app reads or
  writes must live inside that folder. Shortcuts and symlinks are resolved before
  the check, so a link inside the folder cannot reach outside it, and files whose
  names look like credentials are refused everywhere. CSV import,
  reconciliation, report/PDF export, attachment download, and document upload
  all require this fence.
- **Saving a file will not silently replace one.** `export_qbo_artifact` never
  overwrites. Attachment downloads also default to no-clobber unless you
  explicitly opt into replacement.
- **Errors are handled cleanly.** A request failure returns a clear message
  instead of crashing. Multi-write operations can partially succeed, so their
  result/error and the recovery queue must be reviewed rather than assuming an
  all-or-nothing rollback.

For a friendly Q&A version of all this, see [SECURITY.md](SECURITY.md).

> ⚠️ Before you connect a **real (production)** company, read the security notes
> above. Never share `.env`, `tokens*.json`, `.qbo-token-stage-*.json`, or any
> `.qbo-*-recovery-*.json` files.

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
3. Find the **Keys & OAuth** page for the environment you are connecting. Copy
   its **Client ID** and **Client Secret**.
4. Register the redirect for the flow you will use:
   - **Sandbox localhost flow:** `http://localhost:3000/callback`
   - **Production Playground flow:**
     `https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`
   - **Optional production catcher:** the HTTPS URL of the catcher page you
     deploy from `docs/oauth-catcher/`

Sandbox and production keys are separate. Registering the localhost URI does
not make it valid for production.

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

Run the local diagnostic before authorizing anything:

```bash
npm run doctor
```

It checks Node, credential pairs, the file fence, token-file permissions,
policy syntax, the audit directory, tool profile, and host configuration
without printing secrets or contacting Intuit.

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

**Adding many sandbox companies at once?** Use the batch tool with the exact
roster slug for every company, in the order you will select them. It never
derives slugs. **Same command on Mac and Windows:**
```bash
npm run connect:batch -- --slug acme --slug northwind
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
In Claude Desktop, open **Settings → Connectors**, click the **`qbo`** connector,
and you'll see its **Tool permissions**. This controls when Claude acts on its own
versus asking you first.

Each tool can be set to **Always allow** (✓), **Needs approval** (✋), or **Never**
(⛔). Every tool tells Claude Desktop whether it only reads, whether it destroys
anything, and whether running it twice is safe, so the list should already group
sensibly. What we'd set:

| What the tools do | Examples | Set to | Why |
|---|---|---|---|
| Read lists/searches | `get_invoices`, every `search_…`, `get_transaction_links` | **Always allow** | These only look. Approving each one slows Claude down and buys no safety. |
| Reports and inline PDFs | `get_profit_and_loss`, `get_balance_sheet`, aging and GL reports, `get_invoice_pdf` | **Always allow** | These are pure reads and do not write local files. |
| Export a local artifact | `export_qbo_artifact` | **Needs approval** | This explicitly writes a fenced, private, no-clobber JSON or PDF file. |
| Check the setup | `health_check`, `list_companies`, `list_clients`, `resolve_client`, `get_company_policy`, `list_unresolved_writes` | **Always allow** | Local/read-only context, and the first things you want when something is broken. |
| Read anything raw (`developer`/`full` only) | `api_get` | **Always allow** | GET only. Narrower profiles hide raw escape hatches to reduce tool-selection mistakes. |
| Post and edit | `create_invoice`, `create_bill`, `create_journal_entry`, `create_bill_payment`, every `update_…` | **Needs approval** | These change real books. One human look per posting. |
| Leave the building | `send_invoice_email`, `send_estimate`, `send_sales_receipt`, `attach_file` | **Needs approval** | A client sees the result. You cannot un-send an email. |
| Preview a bank CSV | `preview_bank_csv_import` | **Needs approval** | It does not post to QBO, but records locally that this exact preview was reviewed. |
| Do many things at once | `import_transactions_from_csv`, `execute_batch`, `create_journal_entry_multi` | **Needs approval** | One approval covers many postings, which makes it the one most worth reading. |
| Change the guardrails | `set_company_policy`, `connect_company`, `register_client` | **Needs approval** | They change what the connector is allowed to do next. |
| Void | `void_invoice`, `void_payment`, `void_sales_receipt` | **Needs approval** | Zeroes the transaction but keeps the number trail, so it is recoverable. |
| Delete permanently (`full` only) | `delete_transaction` | **Never** | Cannot be undone. Voiding is almost always the right move instead. |
| Write anything raw | `api_request` | **Never** | It can send anything to QuickBooks, including things no other tool exposes. Turn it on only when you need it. |

You get quick answers on anything that just reads, and a confirmation step on
anything that posts. There is only one `qbo` connector, so you set this once, not
once per client.

**Tool profiles.** Set `QBO_TOOL_PROFILE` in `.env`, then restart the MCP host:

- `core` (default): bounded everyday firm workflows and client labels, including the read-only aged detail and recurring-template reports the close-review prompts need. Editing write policies is deliberately NOT here
- `owner`: summaries, receivables, payables, and documents
- `bookkeeper`: daily bookkeeping, reconciliation, detailed reports, reversible corrections, and client labels
- `accountant`: the broad bookkeeper surface plus journal entries, multi-company work, client labels, and local write policies
- `admin`: connection, roster, write policies, and diagnostics only
- `developer`: accountant and OAuth administration tools plus raw API escape hatches; destructive raw operations still require `full`
- `full`: the complete compatibility surface, including permanent deletion

Profiles are selected at process startup, so one conversation cannot broaden
the tool surface seen by another.

**Firm-wide off switches.** Per-tool settings live in Claude Desktop; these live
in `.env` and apply no matter what the app is asked to do. Set
`QBO_DISABLE_WRITES=true` and QBO bookkeeping/outward-write tools (creates,
updates, sends, voids, deletes, imports, attachments, and raw/batch POSTs) are
never registered, or set `QBO_DISABLE_DELETES=true` to remove just deletes and
voids. This is a QuickBooks posting switch, not filesystem read-only mode:
OAuth administration and local session/config/file tools such as client labels,
policies, previews, exports, and downloads remain available when their selected
tool profile includes them.

Stuck on a step? Tell Claude Code what happened. For a sandbox company it can
re-run `QBO_COMPANY=<slug> npm run connect -- --replace-existing`; for production
it uses `npm run connect:playground -- <slug> --replace-existing` (or your
configured HTTPS catcher with the same flag). Replacement is refused unless the
environment and returned realm still match the slug already on disk.

> **Testing:** see **[TESTING.md](TESTING.md)** for a staged verification checklist (automated, sandbox, production pilot).
>
> **Developers:** technical setup, the full tool list, and architecture live in
> **[DEVELOPER.md](DEVELOPER.md)**.

## Help & support

Stuck on a step or seeing an error? Tell Claude (Code or Desktop) exactly what
happened. It can re-check the connection or walk the setup again with you. Use
the localhost `npm run connect` flow only for sandbox companies; re-authorize
production with `npm run connect:playground -- <slug>` or the configured HTTPS
catcher; add `--replace-existing` when repairing an existing slug. The
`health_check` tool is the fastest first step: it verifies every
connected company's tokens and API access in one call.

---

## License and lineage

Apache License 2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). The connector
adopts design patterns from Intuit's
[quickbooks-online-mcp-server](https://github.com/intuit/quickbooks-online-mcp-server).
The original connector was built
by Isaac (Opzer) and is extended here with his permission.

Fork it, modify it, run it at your firm. If you make it better, please send
the improvement back as a pull request or an issue (see
[CONTRIBUTING.md](CONTRIBUTING.md)) so every firm using it benefits.
