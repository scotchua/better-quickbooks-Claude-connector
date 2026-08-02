# Better QuickBooks Connector

Connect Claude Desktop straight to **QuickBooks Online** — and work in **all your
companies from one connector**, not one at a time. Read *and* write.

Built on the [Model Context Protocol](https://modelcontextprotocol.io).
Originally built by Opzer.

## Who this is for

This is for **accountants and bookkeepers** who use QuickBooks Online for more
than one company and want Claude to help with real work — pulling reports,
cleaning up the books, sending invoices, and entering transactions.

The QuickBooks connector that comes built into Claude has two big limits:

- It is **read-only.** It can look, but it cannot make an invoice, a bill, or a
  journal entry.
- It points at **one company at a time.** If you handle 5, 20, or 50 client
  files, switching back and forth gets slow and clumsy.

This tool fixes both:

- **Many companies, one connector.** Connect all your client files once. Then
  just tell Claude which one to use — *"work on Acme."* No switching connectors,
  no restarts.
- **Read *and* write.** Create invoices, bills, journal entries, and more — the
  things you actually do in QuickBooks.
- **114 tools** covering reports, transactions, searches with typed filters,
  bill payments, invoice and estimate PDFs, attachments, change tracking,
  reconciliation, multi-company consolidation, diagnostics, and a safe bulk
  CSV import. Connecting a new client happens in the chat: Claude hands you an
  Intuit link, you click Allow, and it confirms which company landed.

You do **not** need to know how to code. The setup below is copy-and-paste.

> 👉 **Prefer an even simpler walkthrough?** See
> **[SETUP_GUIDE.md](SETUP_GUIDE.md)** — the same process boiled down to just
> telling Claude Code *"help me install this for N clients"* and pasting your keys.

## What you can do

- **Pull reports:** Profit & Loss, Balance Sheet, Cash Flow, Trial Balance,
  General Ledger, A/R and A/P aging, overdue invoices.
- **Enter and edit work:** customers, vendors, items, accounts, invoices, bills,
  bill payments, transfers, expenses, estimates, sales receipts, credit memos,
  payments, deposits, and journal entries, with class, location, and sales-tax
  tagging on line items.
- **Speed up month-end:** import a bank CSV (with a preview first, sign-aware,
  and safe to re-run), attach source documents, run collections, and pull
  "what changed since" reports for any entity.
- **Work across clients:** switch between companies in one connector, or name one
  per request. Run a consolidated P&L or Balance Sheet across every client at
  once, or post the same journal entry (like a monthly management fee) to many
  files in one call.
- **Review the books:** reconcile a bank statement against the register, scan
  for duplicate transactions, and pull a flat general ledger with review flags
  (weekend postings, large or round amounts, journal entries).

---

## Security — what we did to keep your books safe

This app can change **real** accounting data, so safety was built in from the
start. Here is **every** safety feature, in plain words.

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

- **You pick the company. The app never guesses on a write.** You can name the
  company on any request, or set an active one first with **`select_company`**
  (and check it with **`get_active_company`** or **`list_companies`**). For
  anything that **changes** your books — an invoice, a bill, a journal entry —
  the app will **stop and ask** if you did not say which company. It will only
  auto-pick for harmless "read" actions, and only when just one company is
  connected. So a payment can never quietly land in the wrong client's file.
- **Only real company names are accepted.** If you name a company that is not
  connected, the app refuses and shows you the list of ones that are.
- **The company name is cleaned first.** Names are stripped down to plain
  letters, numbers, dashes, and underscores. This stops a tricky name from
  reaching any file outside the app's own folder.
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
- **Every change is written down.** Each action that changes your books is
  recorded in a local log (`audit-log/`), so you can always answer "what did
  Claude post, and when." Writes dated into a closed period come back with a
  warning.

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

- **Preview before you post.** The bank-CSV import has a **`dry_run`** mode: it
  shows you what it *would* do — every row and its category — before anything is
  saved. You approve, then it posts.
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
"Continue" / "Next" until it finishes.

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
Secret after `QBO_CLIENT_SECRET=`. Save and close the window.

**Step 6 — Connect a company.**
Pick a short nickname for the company (letters/numbers only, e.g. `acme`). Paste
the line **for your system**, replacing `acme` with your nickname:

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
(⛔). Our recommendation:

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
