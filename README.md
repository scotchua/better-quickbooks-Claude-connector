# QBO MCP Server

A custom Model Context Protocol server that connects Claude Desktop directly to a
QuickBooks Online company — full read **and** write access via the QBO API.

Built following the *Build Your Own QBO MCP Server* SOP (Nerd Enterprises / 97 & Up).

## Tools (16)

**Read (9):** `get_profit_and_loss`, `get_balance_sheet`, `get_cash_flow`,
`get_aged_receivables`, `get_aged_payables`, `get_invoices`, `get_overdue_invoices`,
`query`, `get_company_info`

**Write (7 + 1 extended):** `create_customer`, `update_customer`, `create_item`,
`create_invoice`, `create_bill`, `create_account`, `send_invoice_email`,
`import_transactions_from_csv`

## Setup

### 1. Install dependencies
```bash
cd ~/Desktop/qbo-mcp-server
npm install
```

### 2. Fill in your keys (Step 7 of the SOP)
Open `.env` and replace the placeholders with your Intuit Developer keys:
```
QBO_CLIENT_ID=...
QBO_CLIENT_SECRET=...
QBO_REDIRECT_URI=http://localhost:3000/callback
QBO_ENVIRONMENT=sandbox
```
> The redirect URI must match exactly what you registered in the developer portal (Step 5).
> Never commit `.env` or `tokens.json` — they're already git-ignored.

### 3. Authorize QuickBooks (one time)
```bash
npm run connect
```
A browser opens → log in with your Intuit credentials → **Allow**. Tokens are saved to
`tokens.json` and auto-refresh for ~100 days. Re-run this command any time you need to
re-authorize or switch companies.

### 4. Connect to Claude Desktop (Step 8)
Merge `claude_desktop_config.snippet.json` into your Claude Desktop config at:
```
~/Library/Application Support/Claude/claude_desktop_config.json
```
Then fully quit and reopen Claude Desktop. The `qbo` server appears under
**Settings → Connectors**.

## Multiple companies (accounting files)

Each company gets its own token file, selected by the `QBO_COMPANY` env var:

- Unset → `tokens.json` (original single-company behavior).
- `QBO_COMPANY=8315` → `tokens.8315.json`.

**Add a company:**
```bash
QBO_COMPANY=<name> npm run connect      # authorize → writes tokens.<name>.json
```
Then add a connector per company in your Claude Desktop config (see
`claude_desktop_config.snippet.json`), each with its own `QBO_COMPANY` in `env`.
Restart Claude Desktop — every company shows up as its own connector (`qbo-8315`,
`qbo-db2f`, …), all usable at once.

> A **production** company needs its own keys: add `QBO_ENVIRONMENT=production`,
> `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` to that connector's `env` block. Values in the
> Claude Desktop config override `.env`, so per-company overrides work cleanly.

## Notes
- All server logging goes to **stderr** — stdout is reserved for the MCP protocol.
- `create_invoice` attaches lines to an existing Service item; if none exists, create one
  first with `create_item`.
- `import_transactions_from_csv` supports a `dry_run` preview; live posting is wired for
  `Expense` (QBO `Purchase`) transactions via the batch API.
- Sandbox starts empty — seed a few customers/invoices/bills in QBO before expecting read
  tools to return data.
