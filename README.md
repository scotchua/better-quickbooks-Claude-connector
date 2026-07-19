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

## Setup

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
