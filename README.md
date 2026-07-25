# Better QuickBooks Connector

Connect Claude Desktop straight to **QuickBooks Online** — and work in **all your
companies from one connector**, not one at a time. Read *and* write.

Built on the [Model Context Protocol](https://modelcontextprotocol.io).

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
- **54 tools** covering reports, transactions, lists, attachments, and a safe
  bulk CSV import.

You do **not** need to know how to code. The setup below is copy-and-paste.

## What you can do

- **Pull reports:** Profit & Loss, Balance Sheet, Cash Flow, Trial Balance,
  General Ledger, A/R and A/P aging, overdue invoices.
- **Enter and edit work:** customers, vendors, items, accounts, invoices, bills,
  expenses, estimates, sales receipts, credit memos, payments, deposits, and
  journal entries.
- **Speed up month-end:** import a bank CSV (with a preview first), attach source
  documents, and run collections.
- **Work across clients:** switch between companies in one connector, or name one
  per request.

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

**Step 7 — Tell Claude Desktop about the app.**
The easiest way is to let Claude do it for you: open **Claude Code** and type
`/add-qbo-company`, then follow the prompts. It sets everything up and checks it
worked. (If you'd rather do it by hand, see *Setup (quick reference)* below.)

**Step 8 — Restart Claude Desktop.**
- **Mac:** Quit Claude Desktop completely (`Cmd + Q`), then open it again.
- **Windows:** Right-click the Claude icon in the **system tray** (bottom-right,
  by the clock), choose **Quit**, then open it again. Just closing the window
  isn't enough — it keeps running in the tray.

Your companies now appear, and you can ask things like *"list my QuickBooks
companies"* or *"show me last month's profit and loss for acme."*

Stuck on a step? See
[the troubleshooting guide](.claude/skills/add-qbo-company/references/troubleshooting.md).

## Setup (quick reference)

### 1. Install
```bash
npm install
```

### 2. Configure keys
```bash
cp .env.example .env
```
Fill in your Intuit Developer app's `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET`
(from https://developer.intuit.com → your app → Keys & OAuth). The
`QBO_REDIRECT_URI` must match a redirect URI registered on the app exactly.

### 3. Authorize a company (one time each)
```bash
# Unified multi-company setup — give each company a short slug:
QBO_COMPANY=<slug> npm run connect      # writes tokens.<slug>.json

# Or a single default company:
npm run connect                          # writes tokens.json

# Or add several in one browser session (log in once, pick + Allow each):
npm run connect:batch                    # interactive
npm run connect:batch -- --count 50      # fixed number
```
A browser opens → log in to the QuickBooks company → **Allow**. Tokens are saved
locally and auto-refresh (~100 days).

The easiest way to add companies is the bundled **`add-qbo-company` skill** (see
below) — it runs the connect flow, registers the connector, and validates both.

### 4. Connect to Claude Desktop
Add one server entry pointing at `src/index.js` to your Claude Desktop config
file. It lives at:
- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

For the unified multi-company setup, use a single entry **without** `QBO_COMPANY`.

Mac:
```json
{
  "mcpServers": {
    "qbo": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/qbo-mcp-server/src/index.js"]
    }
  }
}
```
Windows (use `node.exe`, and **double** every backslash in JSON):
```json
{
  "mcpServers": {
    "qbo": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\you\\Desktop\\qbo-mcp-server\\src\\index.js"]
    }
  }
}
```
Fully **quit and reopen** Claude Desktop. `qbo` appears under
**Settings → Connectors** with all 54 tools.

## Multiple companies (one connector)

Each company is a `tokens.<slug>.json` file. Within one connector you choose the
company at runtime:

- **`list_companies`** — see every connected company (slug, realm, environment).
- **`select_company`** — set the active company for following calls.
- **`get_active_company`** — check which is active.
- Every tool also takes an optional **`company`** argument to override per call.

Resolution precedence per call: *explicit `company` → session default → env
`QBO_COMPANY` → sole company (reads only) → error listing choices.* Write tools
never auto-pick — see the **Security** section above.

> Typical flow in Claude: *"list my companies"* → *"work on 8315"* → *"create a
> journal entry: debit Accounting 500, credit Checking 500"*.

### The `add-qbo-company` skill

Bundled at [`.claude/skills/add-qbo-company/`](.claude/skills/add-qbo-company/).
Invoke it in Claude Code with `/add-qbo-company` (or ask to "add another
QuickBooks company"). It handles the three moving parts — **authorize**
(browser login → token file), **register** (adds the connector to the Claude
Desktop config, with backup + idempotent edits), and **verify** (cross-checks
that a company is both authorized and registered) — with Python helpers
(`scripts/list_companies.py`, `scripts/register_connector.py`) and a
troubleshooting reference.

## Tools (54)

**Company selection (3):** `list_companies`, `select_company`, `get_active_company`

**Reports & reads (15):** `get_profit_and_loss`, `get_balance_sheet`,
`get_cash_flow`, `get_aged_receivables`, `get_aged_payables`, `get_invoices`,
`get_overdue_invoices`, `query`, `get_company_info`, `get_general_ledger`,
`get_trial_balance`, `get_transaction_list`, `get_transaction_list_by_vendor`,
`get_transaction_list_by_customer`, `get_transaction_list_with_splits`

**Core writes (8):** `create_customer`, `update_customer`, `create_item`,
`create_invoice`, `create_bill`, `create_account`, `send_invoice_email`,
`import_transactions_from_csv`

**Journal entries (2):** `create_journal_entry`, `update_journal_entry`

**Sales transactions (12):** `create_estimate`, `update_estimate`,
`send_estimate`, `update_invoice`, `void_invoice`, `create_sales_receipt`,
`update_sales_receipt`, `send_sales_receipt`, `create_credit_memo`,
`create_refund_receipt`, `create_payment`, `create_deposit`

**Purchases & vendors (8):** `create_expense`, `update_purchase`,
`create_bill_item_based`, `update_bill`, `create_vendor_credit`,
`create_purchase_order`, `create_vendor`, `update_vendor`

**People & items (3):** `create_employee`, `create_time_activity`, `update_item`

**Attachments & advanced (3):** `attach_file`, `get_attachments`, `api_request`

> `api_request` is the escape hatch for anything not wrapped: pass a path under
> `/v3/company/{realmId}` (e.g. `/reports/ProfitAndLossDetail?...`,
> `/query?query=SELECT * FROM Bill`) and it handles auth, realm, and minorversion.

## Notes

- Line-item tools accept account/item/customer references by **name or Id**.
- Item-based tools (purchase orders, item-based bills) need **purchasable**
  items (ones with an expense account).
- `import_transactions_from_csv` supports a `dry_run` preview; live posting is
  wired for `Expense` (QBO `Purchase`) via the batch API.
- Sandbox companies start empty — seed some data before expecting reads to return
  rows.
- All logging goes to **stderr**; stdout is the MCP protocol channel.

## Architecture

- `src/qbo.js` — OAuth (authorize / refresh), per-company token resolution,
  authenticated request + multipart upload helpers, company discovery.
- `src/index.js` — the MCP server: tool definitions, company-resolution +
  write-gate, line-item builders.
