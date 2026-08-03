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

**Production companies** (Intuit rejects localhost redirect URIs outside the
development environment) — two supported paths, pick either:

```bash
# A. Hosted catcher page: Intuit redirects to a static page that shows the
#    one-time code; paste it back. Page location is QBO_CATCHER_REDIRECT_URI
#    (see docs/oauth-catcher/ to host it on firm infrastructure).
npm run connect:catcher -- <slug>

# B. Intuit's own OAuth 2.0 Playground: mint tokens on developer.intuit.com,
#    paste the Realm ID and Refresh Token back (input hidden). No non-Intuit
#    hosting anywhere in the path. One-time setup: add
#    https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl
#    as a Redirect URI on the app's production keys page.
npm run connect:playground -- <slug>
```

Both verify the landed company's name afterward and store tokens encrypted.
For comparison, Intuit's own MCP server solves the same restriction with an
ngrok tunnel; that path is deliberately not used here (per-session URLs, a
third-party tunnel in the auth path).

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
**Settings → Connectors** with all 114 tools.

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
QuickBooks company"). It authorizes the company (browser login writes the token
file), ensures the single unified `qbo` connector is registered (first time
only, with backup + idempotent config edits), and verifies both, using Python
helpers (`scripts/list_companies.py`, `scripts/register_connector.py`) and a
troubleshooting reference. After the first setup, adding a company needs no
restart. Legacy per-company `qbo-<slug>` connectors still work; the scripts
report them and support migration to the unified entry.

## Tools (114)

**Added 2026-08-02** (16): get_preferences, get_aged_receivables_detail,
get_aged_payables_detail, get_profit_and_loss_detail, get_inventory_valuation,
get_item_sales, get_unbilled_time, get_recurring_transactions,
download_attachment, execute_batch, create_invoice_from_estimate,
create_reversing_journal_entry, update_account, update_employee, void_payment,
void_sales_receipt. Aging tools gained report_date/aging_method; P&L, Balance
Sheet, and Cash Flow gained summarize_column_by; every literal date argument is
schema-validated; every write response echoes the company it hit; deletes and
voids are policy-checked against the fetched entity's amount and date.

**Company selection & diagnostics (4):** `list_companies`, `select_company`,
`get_active_company`, `health_check`

**Interactive setup, no terminal (5):** `connect_company`, `check_connection`,
`cancel_connection`, `set_company_policy`, `get_company_policy`

**Client roster (3):** `list_clients`, `resolve_client`, `register_client`.
Authorization stays the truth for which clients exist; `clients.json`
(gitignored) adds the firm's names, aliases, engagement type, and working
folder, and `list_clients` reports drift in both directions.

**Fleet / multi-company (3):** `get_consolidated_profit_and_loss`,
`get_consolidated_balance_sheet`, `create_journal_entry_multi`

**Reconciliation & review (3):** `reconcile_bank_csv`,
`find_duplicate_transactions`, `get_general_ledger_flat`

**Search & lists (10):** `search_customers`, `search_vendors`, `search_items`,
`search_accounts`, `search_terms`, `search_payment_methods`,
`search_tax_codes`, `get_bills`, `get_payments`, `get_estimates` (all take
typed, allowlisted `filters` plus sort)

**AP payments & transfers (3):** `create_bill_payment`, `get_bill_payments`,
`create_transfer`

**Change tracking (1):** `get_changes_since` (QBO Change Data Capture, ~30 days)

**Reports & reads (20):** `get_profit_and_loss`, `get_balance_sheet`,
`get_cash_flow`, `get_aged_receivables`, `get_aged_payables`, `get_invoices`,
`get_overdue_invoices`, `query`, `get_company_info`, `get_general_ledger`,
`get_trial_balance`, `get_transaction_list`, `get_transaction_list_by_vendor`,
`get_transaction_list_by_customer`, `get_transaction_list_with_splits`,
`get_customer_balance`, `get_sales_by_customer`, `get_vendor_balance`,
`get_vendor_expenses`, `get_budgets`

**Documents (2):** `get_invoice_pdf`, `get_estimate_pdf`

**Setup entities (6):** `create_class`, `update_class`, `create_department`,
`update_department`, `create_payment_method`, `create_term`

**Danger zone (1):** `delete_transaction` (permanent; policy-checked and
audit-logged)

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

**Attachments & advanced (4):** `attach_file`, `get_attachments`, `api_get`,
`api_request`

> `api_get` and `api_request` are the escape hatches for anything not wrapped:
> pass a path under `/v3/company/{realmId}` (e.g.
> `/reports/ProfitAndLossDetail?...`, `/query?query=SELECT * FROM Bill`) and
> auth, realm, and minorversion are handled. `api_get` is read-only (safe to
> always-allow); `api_request` can POST and belongs behind approval.


## Token broker for sibling tools

`node src/index.js --access-token <slug>` prints one JSON line
(`{slug, realmId, environment, access_token, expires_at}`) on stdout and logs to
stderr. This is the ONLY supported way for another local process to reach
QuickBooks with this connector's authorizations: Intuit rotates the refresh
token on every refresh and invalidates the one it replaces, so exactly one
process (this server) ever refreshes. The Python services under
`~/Claude/qbo-collector` call this and cache the one-hour access token per
realm. Every issuance is written to the audit log (`kind: token_brokered`,
with the caller's parent pid). The refresh token never leaves this process.

## Hardening env vars

- `QBO_FILES_DIR`: when set, every user-supplied local file path (CSV import,
  reconcile, attachments, PDF/attachment save paths) must resolve inside this
  directory tree; credential-shaped filenames (.env*, tokens*.json, keys) are
  refused regardless. Recommended: the client-files root, e.g. `~/Claude`.
- `QBO_REQUIRE_EXPLICIT_COMPANY=true`: writes require an explicit `company`
  argument on every call; session (`select_company`) and env defaults stop
  applying to writes. Recommended when several conversations share the
  connector, since the session default is process-global.
- Existing switches: `QBO_DISABLE_WRITES`, `QBO_DISABLE_DELETES`,
  `QBO_CLOSED_PERIOD=warn|block|off`, `QBO_POLICY_FILE`, `QBO_AUDIT=off`,
  `QBO_AUDIT_DIR`, `QBO_TIMEOUT_MS`, `QBO_PDF_MAX_BYTES`, `QBO_MINOR_VERSION`.

## Known-broken QBO endpoints (deliberately not wrapped)

- `reports/BudgetVsActuals`: returns HTTP 200 with an Actual column that is
  inception-to-date regardless of the requested dates. Budget-vs-actual is done
  by joining the Budget entity (get_budgets verbose) to monthly P&L.
- The sales-tax report family (`reports/TaxSummary` and siblings): unreliable;
  compute sales-tax positions from the liability account's general ledger.
- Webhooks: a local desktop process cannot receive them; scheduled CDC polling
  via get_changes_since is the supported substitute.

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
- **Per-company policies** (optional `qbo-policy.json`, see
  `qbo-policy.example.json`; `QBO_POLICY_FILE` overrides the path): `read_only`
  companies, `max_write_amount` ceilings, and a `min_txn_date` floor, enforced
  centrally at the API layer so every write tool (including `api_request`)
  obeys them.
- **Fleet tools** merge per-company report trees by account name;
  `create_journal_entry_multi` requires an explicit company list and returns
  per-company results.
- **Reconciliation** matches statement rows to Purchases/Deposits on exact
  amount within a date tolerance; transfers and bill payments are not scanned.
- Name-index lookups (fuzzy matching, suggestions) are cached for 60 seconds
  per company and entity; exact-name lookups always hit the API directly.
- **Verb-category kill switches** (pattern from Intuit's MIT MCP server):
  `QBO_DISABLE_WRITES=true` skips registering every write-capable tool;
  `QBO_DISABLE_DELETES=true` skips only deletes/voids. Suppressed tools never
  appear in the client. Read tools are always registered.
- **Advanced search filters:** every search/list tool takes
  `filters: [{field, value, operator}]` validated against a per-entity
  allowlist of QBO's filterable columns (operators `=`, `<`, `>`, `<=`, `>=`,
  `LIKE`, `IN`), plus `order_by`/`descending` on the name searches.
- PDFs save under `exports/` by default (gitignored); cap the download size
  with `QBO_PDF_MAX_BYTES`.
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
- `src/reports.js`: report-tree flattening, multi-company consolidation, flat
  GL export with review flags.
- `src/reconcile.js`: statement-vs-register matching, duplicate detection.
- `src/policy.js`: per-company write policies (read-only, amount ceiling, date
  floor), enforced in `qboRequest`.
- `src/compact.js`: trimmed list-response shapes.
- `src/util.js`: pure helpers (escaping, id validation, balance checks).
- `test/`: vitest unit tests; `.github/workflows/ci.yml`: CI.

## Troubleshooting

For common setup snags (port in use, refresh-token expiry, wrong realm, a
company authorized but not registered), see
[the troubleshooting guide](.claude/skills/add-qbo-company/references/troubleshooting.md).
