# QBO MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects
Claude Desktop directly to **QuickBooks Online** — full read **and** write access
via the QBO API, across **multiple companies from a single connector**.

- **54 tools** — reports, the full transaction/entity set (invoices, bills,
  estimates, sales receipts, journal entries, payments, deposits, purchase
  orders, …), attachments, and a raw API escape hatch.
- **Multi-company, one connector** — pick which company to run against at
  runtime; no need for a separate connector per company.
- **Write-safety gate** — writes never post to the wrong books (see
  [SECURITY.md](SECURITY.md)).

> ⚠️ This talks to **real accounting data**. Read [SECURITY.md](SECURITY.md)
> before you connect a production company. Secrets (`.env`, `tokens*.json`) are
> git-ignored and must never be committed.

## Step-by-step setup (no coding experience needed)

This takes about 20 minutes. You will copy and paste a few commands. You do not
need to understand them — just follow along in order.

**Before you start, you need:**
- A Mac.
- The QuickBooks Online login for the company you want to connect.
- [Claude Desktop](https://claude.ai/download) installed.
- About 20 minutes.

**Step 1 — Install Node (the engine this app runs on).**
Go to [nodejs.org](https://nodejs.org), click the big button that says **LTS**,
and run the file it downloads. Click "Continue" until it finishes.

**Step 2 — Download this project.**
On this page, click the green **Code** button, then **Download ZIP**. Open the
downloaded file to unzip it, and drag the `qbo-mcp-server` folder onto your
Desktop.

**Step 3 — Open the Terminal app.**
Press `Cmd + Space`, type `Terminal`, and press Enter. A window with a blinking
cursor opens. This is where you paste commands. Paste this one and press Enter:
```bash
cd ~/Desktop/qbo-mcp-server && npm install
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
In Terminal, paste this and press Enter to make your settings file:
```bash
cp .env.example .env && open -e .env
```
A text window opens. Paste your Client ID after `QBO_CLIENT_ID=` and your Client
Secret after `QBO_CLIENT_SECRET=`. Save (`Cmd + S`) and close the window.

**Step 6 — Connect a company.**
Pick a short nickname for the company (letters/numbers only, e.g. `acme`). Paste
this, replacing `acme` with your nickname:
```bash
QBO_COMPANY=acme npm run connect
```
Your web browser opens. Log in to the QuickBooks company and click **Allow**.
When you see "✅ QuickBooks connected," close that browser tab. Repeat this step
for each company you want to add (use a different nickname each time).

**Step 7 — Tell Claude Desktop about the app.**
The easiest way is to let Claude do it for you: open **Claude Code** and type
`/add-qbo-company`, then follow the prompts. It sets everything up and checks it
worked. (If you'd rather do it by hand, see *Setup (quick reference)* below.)

**Step 8 — Restart Claude Desktop.**
Quit Claude Desktop completely (`Cmd + Q`), then open it again. Your companies now
appear, and you can ask things like *"list my QuickBooks companies"* or *"show me
last month's profit and loss for acme."*

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
```
A browser opens → log in to the QuickBooks company → **Allow**. Tokens are saved
locally and auto-refresh (~100 days).

The easiest way to add companies is the bundled **`add-qbo-company` skill** (see
below) — it runs the connect flow, registers the connector, and validates both.

### 4. Connect to Claude Desktop
Add one server entry pointing at `src/index.js` to your Claude Desktop config at
`~/Library/Application Support/Claude/claude_desktop_config.json`. For the
unified multi-company setup, use a single entry **without** `QBO_COMPANY`:
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
never auto-pick — see [SECURITY.md](SECURITY.md).

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
