# Developer & technical reference

Technical setup, tooling, and architecture for the QuickBooks connector. If you
just want to install it, start with the non-technical
**[SETUP_GUIDE.md](SETUP_GUIDE.md)** or the step-by-step in
[README.md](README.md).

This repository is the generic, local connector: Apache-2.0, free to fork, with
no hosted MHPE service or paid tier. Keep firm-specific methodology, prompts,
and engagement procedures in a separate private skills layer.

The server exposes generic MCP context rather than embedding that methodology:
`qbo://companies`, `qbo://clients`, `qbo://policy`, and
`qbo://company/{slug}/context`, plus profile-gated prompts for month-end, close
readiness, business health, collections, transaction tracing, and bank
reconciliation. Hosts that cannot make resources model-callable can use the
equivalent `get_preferences` and `get_company_policy` tools; prompt text names
that fallback explicitly.

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

The localhost commands below are for **sandbox companies only**. Register
`http://localhost:3000/callback` on the app's development Keys & OAuth page.

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
locally and refresh automatically until Intuit reports that reauthorization is required.

**Production companies** (Intuit rejects localhost redirect URIs outside the
development environment) — two supported paths, pick either:

```bash
# RECOMMENDED. Intuit's own OAuth 2.0 Playground: mint tokens on
# developer.intuit.com, paste the Realm ID and Refresh Token back (input
# hidden). Nothing to host, no third party in the path. One-time setup: add
#   https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl
# as a Redirect URI on the app's production Keys & OAuth page.
npm run connect:playground -- <slug>

# ALTERNATIVE, if you would rather host a page: Intuit redirects to a static
# page that shows the one-time code and you paste it back. There is NO default
# page. Deploy docs/oauth-catcher/index.html somewhere you control, register
# that HTTPS URL on your Intuit app, and set QBO_CATCHER_REDIRECT_URI.
npm run connect:catcher -- <slug>          # add --no-browser to print the URL only
```

Both verify the fresh credentials against CompanyInfo before persistence and
store tokens encrypted. The connector deliberately avoids putting a third-party
tunnel in the authorization path.

Use the same environment-specific split for recovery: rerun the localhost
command with `-- --replace-existing` for sandbox; for production rerun
`npm run connect:playground -- <slug> --replace-existing` or the configured
catcher with that flag. Do not point a production recovery at
`http://localhost:3000/callback`. Replacement is accepted only for the same
realm and environment, and fresh credentials read CompanyInfo before saving.

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
**Settings → Connectors** with the startup profile selected by
`QBO_TOOL_PROFILE` (`core` by default; `accountant` is the broad professional
surface and `full` exposes the complete
compatibility surface).

## Multiple companies (one connector)

Each company is a `tokens.<slug>.json` file. Within one connector you choose the
company at runtime:

- **`list_companies`** — see every connected company (slug, realm, environment).
- **`select_company`** — set the active company for following calls.
- **`get_active_company`** — check which is active.
- Read tools take an optional **`company`** argument. Write schemas require it
  by default; `QBO_REQUIRE_EXPLICIT_COMPANY=false` restores legacy inheritance.

Resolution precedence per call: *explicit `company` → session default → env
`QBO_COMPANY` → sole company (reads only) → error listing choices.* Write tools
never auto-pick under the default safety setting — see the **Security** section
of the README.

> Typical flow in Claude: *"list my companies"* → *"work on acme"* → *"create a
> journal entry: debit Accounting 500, credit Checking 500"*.

### Retiring a token file

Company discovery reads the project root and does not recurse, so a token file
you want to keep but not use goes in `backups/`: it stays on disk and stops
appearing in `list_companies`. That is the whole mechanism. It replaced a
hardcoded `sandbox-backup` slug, which hid exactly one filename while every
other backup name quietly stayed selectable. An old `tokens.sandbox-backup.json`
now draws a one-line notice until you move it.

Offboarding a client for real is still `npm run disconnect -- <slug>`, which
revokes the grant with Intuit before deleting anything. Parking a file in
`backups/` hides it from this connector and nothing more: the grant stays live
on Intuit's side.

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

## Tool catalog (full profile)

The MCP `tools/list` response and `src/tool-profiles.js` are authoritative. This
functional overview intentionally avoids a total that would drift whenever a
tool is added or moved between profiles.

Recent additions include: get_preferences, get_aged_receivables_detail,
get_aged_payables_detail, get_profit_and_loss_detail, get_inventory_valuation,
get_item_sales, get_unbilled_time, get_recurring_transactions,
download_attachment, execute_batch, create_invoice_from_estimate,
create_reversing_journal_entry, update_account, update_employee, void_payment,
void_sales_receipt. Aging tools gained report_date/aging_method; P&L, Balance
Sheet, and Cash Flow gained summarize_column_by; every literal date argument is
schema-validated; every write response echoes the company it hit; deletes and
voids are policy-checked against the fetched entity's amount and date.

**Company selection & diagnostics:** `list_companies`, `select_company`,
`get_active_company`, `health_check`

**Interactive sandbox setup, no terminal:** `connect_company`, `check_connection`,
`cancel_connection`, `set_company_policy`, `get_company_policy`

**Client roster:** `list_clients`, `resolve_client`, `register_client`.
Authorization stays the truth for which clients exist; `clients.json`
(gitignored) adds the firm's names, aliases, engagement type, and working
folder, and `list_clients` reports drift in both directions.

**Fleet / multi-company:** `get_consolidated_profit_and_loss`,
`get_consolidated_balance_sheet`, `create_journal_entry_multi`

**Reconciliation & review:** `reconcile_bank_csv`,
`find_duplicate_transactions`, `get_general_ledger_flat`

**Search & lists:** `search_customers`, `search_vendors`, `search_items`,
`search_accounts`, `search_terms`, `search_payment_methods`,
`search_tax_codes`, `get_bills`, `get_payments`, `get_estimates` (all take
typed, allowlisted `filters` plus sort)

**AP payments & transfers:** `create_bill_payment`, `get_bill_payments`,
`create_transfer`

**Change tracking:** `get_changes_since` (QBO Change Data Capture, ~30 days)

**Reports & reads:** `get_profit_and_loss`, `get_balance_sheet`,
`get_cash_flow`, `get_aged_receivables`, `get_aged_payables`, `get_invoices`,
`get_overdue_invoices`, `query`, `get_company_info`, `get_general_ledger`,
`get_trial_balance`, `get_transaction_list`, `get_transaction_list_by_vendor`,
`get_transaction_list_by_customer`, `get_transaction_list_with_splits`,
`get_customer_balance`, `get_sales_by_customer`, `get_vendor_balance`,
`get_vendor_expenses`, `get_budgets`

**Documents:** `get_invoice_pdf`, `get_estimate_pdf` (inline reads),
`export_qbo_artifact` (explicit fenced/no-clobber report JSON or PDF export)

**Setup entities:** `create_class`, `update_class`, `create_department`,
`update_department`, `create_payment_method`, `create_term`

**Danger zone:** `delete_transaction` (permanent; policy-checked and
audit-logged)

**Core writes:** `create_customer`, `update_customer`, `create_item`,
`create_invoice`, `create_bill`, `create_account`, `send_invoice_email`,
`import_transactions_from_csv`

**Journal entries:** `create_journal_entry`, `update_journal_entry`

**Sales transactions:** `create_estimate`, `update_estimate`,
`send_estimate`, `update_invoice`, `void_invoice`, `create_sales_receipt`,
`update_sales_receipt`, `send_sales_receipt`, `create_credit_memo`,
`create_refund_receipt`, `create_payment`, `create_deposit`

**Purchases & vendors:** `create_expense`, `update_purchase`,
`create_bill_item_based`, `update_bill`, `create_vendor_credit`,
`create_purchase_order`, `create_vendor`, `update_vendor`

**People & items:** `create_employee`, `create_time_activity`, `update_item`

**Attachments & advanced:** `attach_file`, `get_attachments`, `api_get`,
`api_request`

> `api_get` and `api_request` are the escape hatches for anything not wrapped:
> pass a path under `/v3/company/{realmId}` (e.g.
> `/reports/ProfitAndLossDetail?...`, `/query?query=SELECT * FROM Bill`) and
> auth, realm, and minorversion are handled. `api_get` is read-only (safe to
> always-allow); `api_request` can POST and belongs behind approval.
> Both are hidden unless the `developer` or `full` profile is selected.


## Token broker for sibling tools

`node src/index.js --access-token <slug>` prints one JSON line
(`{slug, realmId, environment, access_token, expires_at}`) on stdout and logs to
stderr. This is the ONLY supported way for another local process to reach
QuickBooks with this connector's authorizations: Intuit can periodically return
a replacement refresh token and warns that overlapping refresh attempts can
produce `invalid_grant` or invalidate the grant. An owner-aware cross-process
lock serializes refreshes through this connector; sibling tools use the broker
instead of copying or refreshing the credential themselves. Other local
integrations can cache the one-hour access token per realm. Every issuance is
written to the audit log
(`kind: token_brokered`, with the caller's parent pid). The refresh token never
leaves this process.

## Hardening env vars

- `QBO_FILES_DIR`: required for every user-supplied local file path (CSV import,
  reconcile, attachments, PDF/attachment save paths) must resolve inside this
  directory tree; credential-shaped filenames (.env*, tokens*.json, keys) are
  refused regardless. Recommended: the client-files root, e.g. `~/Claude`.
  Symlinks are resolved before the containment check, so a link planted inside
  the tree cannot be used to reach outside it. Import, reconciliation, report
  export, PDF/attachment download, and `attach_file` all refuse to operate
  without it. User-supplied write paths refuse to replace an existing file
  unless an explicit `overwrite: true` option exists and is supplied; report
  artifacts never silently overwrite.
- `QBO_CLIENT_ID_SANDBOX` / `QBO_CLIENT_SECRET_SANDBOX`: Intuit issues separate
  development and production keys per app, and each pair only authenticates
  against its own environment. Set these to serve sandbox companies alongside
  production ones; the pair is selected per company from the environment stored
  in its token file. With only `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET` set, nothing
  changes.
- `QBO_AUDIT=strict`: raise an error when the optional accountability record
  cannot be written. Separately, every write must fsync a body-free durable
  intent before fetch; failure there guarantees the QuickBooks call was not
  sent. The recovery ledger cannot be disabled with `QBO_AUDIT=off`.
- `QBO_REQUIRE_EXPLICIT_COMPANY`: **defaults to true.** Writes require an
  explicit `company` argument on every call; session (`select_company`) and env
  defaults do not apply to writes. The session default is process-global and one
  server serves every open conversation, so a `select_company` in one chat would
  otherwise be able to retarget a write issued from another. Set it to `false`
  for a single-operator setup that wants writes to inherit the defaults again.
- Existing switches: `QBO_DISABLE_WRITES`, `QBO_DISABLE_DELETES`,
  `QBO_CLOSED_PERIOD=warn|block|off`, `QBO_POLICY_FILE`, `QBO_AUDIT=off`,
  `QBO_AUDIT_DIR`, `QBO_TIMEOUT_MS`, `QBO_PDF_MAX_BYTES`,
  `QBO_PDF_MAX_INLINE_BYTES`, `QBO_RESPONSE_MAX_BYTES`, `QBO_MINOR_VERSION`.
- `QBO_TOOL_PROFILE=core|owner|bookkeeper|accountant|admin|developer|full`:
  startup capability surface. `core` is the bounded firm-workflow default;
  `accountant` is the broad professional surface, while raw API and permanent
  deletion require broader profiles. Unknown tools fail closed in curated profiles.

### Raw transaction guard boundary

`api_request` accepts POST only for one-segment entity paths verified in
`RAW_TRANSACTION_ENTITIES` or the explicit non-posting master-data allowlist in
`src/index.js`. An unlisted raw update cannot safely infer its entity type,
fetch its current transaction date, or protect the period the record is being
moved out of, so it is refused. Raw Item writes are also refused: inventory
opening fields can create a valued opening-balance transaction that generic
date/amount guards cannot evaluate. Use the named Item tools for non-inventory
fields. Account, Customer, and Vendor raw/batch writes are refused for the same
reason: their create schemas include opening-balance fields; use their named
tools for the connector's audited field subset. If a new raw entity is genuinely required, first verify its
read/update behavior and response shape, then add it to the allowlist with
focused current-period/source-period tests.

`execute_batch` is stricter: every entity must be in either the verified
transaction map or the explicit non-posting master-data allowlist. Unknown
entity names are refused, because treating a newly added posting entity as
harmless would bypass amount, source-period, and closed-book checks.

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
  `QBO_TOKEN_ENCRYPTION=off` keeps legacy plaintext. With encryption enabled,
  a legacy file migrates on its next successful locked refresh or
  reauthorization; reads never rewrite token state.
- **Every write has a mandatory durable recovery record** in
  `audit-log/write-recovery.jsonl`, fsynced before fetch and completed with an
  outcome afterward. It stores no body, only the exact envelope fingerprint.
  The optional human-facing `audit-YYYY-MM.jsonl` includes Intuit's
  `intuit_tid`; `QBO_AUDIT=off` disables only that second log.
- **Closed-period guardrail:** writes dated on or before the company's
  books-closed date return a warning (`QBO_CLOSED_PERIOD=block` refuses instead).
  An omitted posting `TxnDate` is never replaced with local UTC: Intuit does
  not document the timezone behind its server default, so warn mode reports an
  unverifiable date and block mode requires an explicit `YYYY-MM-DD`.
- **Offboarding:** `npm run disconnect -- <slug>` revokes the OAuth grant with
  Intuit, then deletes the token file.
- List tools return **compact rows** by default; pass `verbose: true` for full
  QBO entities. Results paginate up to 1,000 rows with a `truncated` flag.
- `preview_bank_csv_import` records review of an exact file/company/account;
  `import_transactions_from_csv` is the separate live writer. It is sign-aware
  (credits are never imported as expenses), normalizes dates, and is
  **duplicate-safe on rerun**: each import is journaled locally, confirmed rows
  are skipped, and interrupted rows are healed only when their QBO memo marker
  is found. An absent marker causes a manual-reconciliation refusal instead of
  a second POST, because query absence is not durable proof of non-creation.
- **Per-company policies** (optional `qbo-policy.json`, see
  `qbo-policy.example.json`; `QBO_POLICY_FILE` overrides the path): `read_only`
  companies, `max_write_amount` ceilings, and a `min_txn_date` floor, enforced
  centrally at the API layer so every write tool (including `api_request`)
  obeys them.
- **Fleet tools** merge per-company report trees by account name;
  duplicates, unknown currencies, mixed bases, and partial report sets are
  refused. `create_journal_entry_multi` preflights every company and requires
  a single-use, payload-bound preview `plan_id` before posting.
- **Interrupted writes are recoverable, and replay is guarded.** Every write
  carries an Intuit `requestid`. Measured against a sandbox company on
  2026-08-06, with a control proving duplicates are otherwise possible:
  replaying an id with the **same** body returns the original record and
  creates nothing, and the window was still open at 90 seconds. Replaying it
  with a **different** body also returns the original, HTTP 200, silently
  discarding the new write. That second behaviour is why `qboRequest` compares
  the full request envelope against the mandatory durable intent and refuses a
  company, realm, environment, method, path/query, or full-body-hash mismatch
  before sending. Intuit scopes request ids to a realm, limits ordinary ids to
  50 characters (36 for `/batch`), and publishes no retention window, so the
  connector treats every id as permanently bound and never reusable for other
  content. Permanent local binding does not imply permanent Intuit deduplication:
  manual and automatic replay are capped at 90 seconds by default, the longest
  window measured in that sandbox test. Raising
  `QBO_RECOVERY_REPLAY_MAX_AGE_MS` explicitly accepts unverified duplicate risk.
  Timeouts and HTTP 408/5xx responses report the `request_id` in the error.
  Single-request write tools accept that recovery-only field only for a recent
  unresolved outcome, while `list_unresolved_writes` provides a body-free local
  recovery queue with `replay_eligible`, age, and deadline fields. Composite
  tools (bank-import batches and cross-company journals) intentionally omit
  generic replay; they use a dedicated
  resume/reconciliation path so completed targets are not posted again.
  `QBO_RETRY_WRITES=true` extends automatic retries to writes inside the same
  total replay-age ceiling; it is off by default because the measurement
  covered one entity type in sandbox.
- **Report size is capped inline.** `reportResult` refuses anything over
  `QBO_REPORT_MAX_INLINE_CHARS` (default 300,000), names the actual size, and
  directs the caller to the separately mutating `export_qbo_artifact`. Detail
  reports are why:
  `CustomerBalanceDetail` on a real firm file is over 3M characters, and
  neither `report_date` nor a date range shrinks it (it ignores
  `start_date`/`end_date` outright). Only a customer or vendor filter does.
- **Every JSON/OAuth response is byte-bounded before decoding.**
  `QBO_RESPONSE_MAX_BYTES` defaults to 32 MiB, so an incorrect `Content-Length`
  or chunked upstream response cannot grow memory without limit. PDF and
  attachment bodies retain their separate `QBO_PDF_MAX_BYTES` cap.
  Refusing beats truncating, which would return a report that looks complete.
- **Detail report variants ride on the summary tools** via `detail: true`
  rather than four new tools: `get_customer_balance`, `get_vendor_balance`,
  `get_inventory_valuation`. Note the date arguments are not interchangeable
  between the two forms. The balance reports are as-of (`report_date`) and
  inventory valuation detail is a period report (`start_date`/`end_date`).
  `ClassSales`, `DepartmentSales` and `CustomerIncome` work but are
  deliberately unwrapped; the `api_get` description names them.
- **Reconciliation** builds the register from one account-filtered
  `GeneralLedger` call rather than per-entity queries, so every type that hits
  the account is covered and the signs come from the ledger instead of an
  entity's `Credit` flag. Statement rows are limited to the requested period
  and matched with a maximum-cardinality, minimum-date-distance assignment;
  ambiguous equal candidates are flagged. `bankTieOut` then produces the two-column bridge. Cleared status
  is not available in the API, so nothing is marked reconciled in QuickBooks.
- Name-index lookups (fuzzy matching, suggestions) are cached for 60 seconds
  per company and entity; exact-name lookups always hit the API directly.
- **Verb-category kill switches** (pattern from Intuit's Apache-2.0 MCP server):
  `QBO_DISABLE_WRITES=true` skips QBO bookkeeping/outward-write tools selected
  by the write prefixes plus `api_request` and `execute_batch`;
  `QBO_DISABLE_DELETES=true` skips only deletes/voids. Suppressed tools never
  appear in the client. This is not a blanket local read-only mode: OAuth
  administration and `LOCAL_MUTATORS`/`LOCAL_FILE_WRITERS` remain when their
  selected profile includes them. Both variables accept only literal `true` or
  `false`; a typo stops startup instead of enabling tools.
- **Advanced search filters:** every search/list tool takes
  `filters: [{field, value, operator}]` validated against a per-entity
  allowlist of QBO's filterable columns (operators `=`, `<`, `>`, `<=`, `>=`,
  `LIKE`, `IN`), plus `order_by`/`descending` on the name searches.
- Invoice and estimate PDF getters are pure reads that return bounded inline
  MCP resources. `export_qbo_artifact` writes a caller-chosen report or PDF path
  inside `QBO_FILES_DIR`, with private permissions and no overwrite. Attachment
  downloads default to `QBO_FILES_DIR/exports/<company>/` and may instead use a
  caller-chosen fenced destination. Cap PDF size with `QBO_PDF_MAX_BYTES`.
- Tests: `npm test` (vitest). CI runs syntax checks, tests, and `npm audit`.
- Item-based tools (purchase orders, item-based bills) need **purchasable**
  items (ones with an expense account).
- `preview_bank_csv_import` is the non-posting review step; live
  `import_transactions_from_csv` posts `Expense` (QBO `Purchase`) rows via the
  batch API only after that exact preview has been recorded.
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
- `src/doctor.js`: local, secret-redacting installation diagnostics.
- `src/tool-profiles.js`: curated startup capability surfaces.
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
