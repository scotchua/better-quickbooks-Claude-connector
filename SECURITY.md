# Security

This server holds the keys to real accounting data — OAuth tokens that can read
and **write** to live QuickBooks Online books. These are the decisions that keep
it safe, and what you must do to keep it that way.

## Secrets never enter git

The following are git-ignored (see `.gitignore`) and must **never** be committed:

| File | Contains |
|------|----------|
| `.env` | Intuit app Client ID + Secret |
| `tokens.json`, `tokens.<slug>.json` | Live OAuth **access + refresh tokens** per company |
| `tokens.sandbox-backup.json` | A token backup |
| `save-excels-here/` | Exported financial data (P&L, etc.) |
| `node_modules/` | Dependencies (restored via `npm install`) |

The ignore rule for tokens is `tokens*.json` — a wildcard, deliberately, so that
**every** company's token file is covered, not just the legacy `tokens.json`. If
you clone this repo, you start with no secrets; you supply your own via
`.env` (copy from `.env.example`) and `npm run connect`.

If a token or key is ever committed by accident, treat it as compromised:
rotate the Intuit app secret in the developer portal and re-run `npm run connect`
to mint fresh tokens (which invalidates continued use of the leaked refresh token
once it rotates).

## Per-company isolation

Each QuickBooks company is a separate `tokens.<slug>.json` file. Token loading is
resolved **per request** from the company slug — one company's tokens are never
used for another. The API host (sandbox vs production) is derived from each
token file's stored `environment`, so companies in different environments can't
cross-route.

## Write-safety gate

The server exposes write tools (invoices, bills, journal entries, payments,
deletes/voids). To prevent a transaction from posting to the wrong books:

- Every tool takes an optional `company` argument. Resolution precedence is:
  **explicit `company` → session default (`select_company`) → `QBO_COMPANY` env →
  the sole company (reads only) → error listing the choices.**
- **Write tools never auto-pick a company.** With no explicit argument and no
  session/env default, a write fails with a message listing the available
  companies instead of guessing. Reads may fall back to the sole company for
  convenience; writes may not.

## OAuth handling

- Tokens auto-refresh ~60s before expiry; refresh tokens are valid ~100 days and
  are rotated by Intuit on refresh (the new one is persisted).
- The one-time authorization uses a CSRF `state` parameter validated on the
  callback.
- All server logging goes to **stderr** — stdout is reserved for the MCP protocol
  — so tokens are never printed to the protocol channel.

## Production vs sandbox

`production` companies are **real books** — writes post for real. Sandbox
companies are Intuit test data. Keep production credentials in `.env` (or a
per-connector `env` override) and be deliberate about which company is active
before running any write tool.
