# Developer & technical reference

Technical setup, tooling, and architecture for the QuickBooks connector. If you
just want to install it, start with the non-technical
**[SETUP_GUIDE.md](SETUP_GUIDE.md)** or the step-by-step in
[README.md](README.md).

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
**Settings → Connectors** with all 66 tools.

## Multiple companies (one connector)

Each company is a `tokens.<slug>.json` file. Within one connector you choose the
company at runtime:

- **`list_companies`** — see every connected company (slug, realm, environment).
- **`select_company`** — set the active company for following calls.
- **`get_active_company`** — check which is active.
- Every tool also takes an optional **`company`** argument to override per call.

Resolution precedence per call: *explicit `company` → session default → env
`QBO_COMPANY` → sole company (reads only) → error listing choices.* Write tools
never auto-pick — see the **Security** section of the README.

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

## Tools (66)

**Company selection & diagnostics (4):** `list_companies`, `select_company`,
`get_active_company`, `health_check`

**Search & lists (7):** `search_customers`, `search_vendors`, `search_items`,
`search_accounts`, `get_bills`, `get_payments`, `get_estimates`

**AP payments & transfers (3):** `create_bill_payment`, `get_bill_payments`,
`create_transfer`

**Change tracking (1):** `get_changes_since` (QBO Change Data Capture, ~30 days)

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
  A near-miss on a name (case/spacing) resolves when unambiguous; otherwise the
  error lists close matches.
- Line items accept an optional **`class`**; sales lines accept **`tax_code`**
  (TAX/NON or a TaxCode name); most posting tools accept a header **`location`**
  (department). All require the matching QBO tracking feature to be enabled.
- **Token files are encrypted at rest** (AES-256-GCM). The master key lives in
  the macOS Keychain / Windows DPAPI, or a `0600` `.qbo-key` file elsewhere.
  `QBO_TOKEN_ENCRYPTION=off` keeps legacy plaintext. Legacy files migrate to
  encrypted automatically on first read.
- **Every write is audit-logged** to `audit-log/audit-YYYY-MM.jsonl` (tool-agnostic,
  hooked at the API layer), including Intuit's `intuit_tid` trace id. `QBO_AUDIT=off`
  disables; `QBO_AUDIT_DIR` relocates.
- **Closed-period guardrail:** writes dated on or before the company's
  books-closed date return a warning (`QBO_CLOSED_PERIOD=block` refuses instead).
- **Offboarding:** `npm run disconnect -- <slug>` revokes the OAuth grant with
  Intuit, then deletes the token file.
- List tools return **compact rows** by default; pass `verbose: true` for full
  QBO entities. Results paginate up to 1,000 rows with a `truncated` flag.
- `import_transactions_from_csv` is sign-aware (credits are never imported as
  expenses), normalizes dates, and is **idempotent**: each import is journaled
  locally so a re-run after a failure skips rows that already posted.
- Tests: `npm test` (vitest). CI runs syntax checks, tests, and `npm audit`.
- Item-based tools (purchase orders, item-based bills) need **purchasable**
  items (ones with an expense account).
- `import_transactions_from_csv` supports a `dry_run` preview; live posting is
  wired for `Expense` (QBO `Purchase`) via the batch API.
- Sandbox companies start empty — seed some data before expecting reads to return
  rows.
- All logging goes to **stderr**; stdout is the MCP protocol channel.

## Architecture

- `src/qbo.js`: OAuth (authorize / refresh / revoke), per-company token
  resolution, retry/timeout policy, authenticated request + upload helpers,
  company discovery, audit hook.
- `src/index.js`: the MCP server: tool definitions, company resolution and
  the write-gate.
- `src/entities.js`: entity lookups, tolerant name resolution with
  suggestions, paginated queries, closed-period guardrail.
- `src/lines.js`: line-item schemas and builders (class/location/tax aware).
- `src/secure-store.js`: AES-256-GCM token encryption and master-key
  providers (Keychain, DPAPI, key file).
- `src/audit.js`: append-only JSONL write audit log.
- `src/csv.js`: bank CSV parsing, import planning, idempotency journal.
- `src/compact.js`: trimmed list-response shapes.
- `src/util.js`: pure helpers (escaping, id validation, balance checks).
- `test/`: vitest unit tests; `.github/workflows/ci.yml`: CI.

## Troubleshooting

For common setup snags (port in use, refresh-token expiry, wrong realm, a
company authorized but not registered), see
[the troubleshooting guide](.claude/skills/add-qbo-company/references/troubleshooting.md).
