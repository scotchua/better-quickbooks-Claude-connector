# Architecture, Security, and Product Review

**Subject:** Better QuickBooks Connector (qbo-mcp-server), commit `11f9504`, reviewed 2026-07-31.
**Scope:** Full source (`src/index.js`, `src/qbo.js`), docs, bundled `add-qbo-company` skill, dependency tree.
**Standard applied:** Production use by accounting firms handling sensitive financial data across many client companies.

The review itself changed no code; findings reference the codebase at commit `11f9504` using `file:line`, so cited lines describe the pre-fix state.

**Update 2026-07-31:** the maintainer answered the five open questions. Decisions are recorded in section 15 and the affected recommendations below were updated to match (token storage, vendor marketing, deployment model, persistence).

---

## 1. Executive Summary

**Verdict: a thoughtfully designed connector with genuinely good safety instincts, currently at solid-prototype maturity. It is not yet production-grade for a firm running 20 to 50 client books.** The gap is not the feature set (54 tools is a strong surface). The gap is correctness and durability under real load: silently truncated query results, no throttling or retry handling, token-refresh races in the documented multi-connector deployment, plaintext token storage in the project folder, zero automated tests, and no audit trail of writes.

**What is genuinely good:**

- The company write-gate is a real, well-executed safety design: writes never guess the target company, explicit slugs are validated against authorized companies, and reads only auto-pick when a single company exists (`src/index.js:174-202`).
- OAuth state is generated per attempt and validated on callback in both single and batch flows (`src/qbo.js:174`, `src/qbo.js:455`).
- Sandbox and production hosts are derived per company from each token file, so a test call cannot hit real books (`src/qbo.js:77-82`).
- Refresh-token rotation is handled correctly on the happy path: the newest refresh token is always persisted (`src/qbo.js:270-280`).
- Logging discipline is right for MCP: stderr only, tokens never printed.
- The CSV import ships with a `dry_run` preview, and the batch authorization flow is a real UX innovation for firms onboarding many clients.
- Docs are unusually accessible for non-technical accountants.

**The five most important problems, in order:**

- **Silent truncation produces wrong accounting answers.** `get_invoices` caps at 100 rows (`src/index.js:553`), `get_overdue_invoices` at 500 (`src/index.js:576`), raw `query` returns QBO's default first page, and nothing tells the user rows were dropped. An accountant asking "who is overdue" can get a confidently incomplete answer. This is the highest-priority fix because it corrupts decisions, not just requests.
- **No 429/throttle handling, retries, or timeouts.** Intuit throttles at roughly 500 requests/min per realm with 10 concurrent per app and lower batch limits (see Sources). Every write tool fans out N+1 lookup queries, so bulk work will hit 429s, which surface as hard failures; a hung socket hangs the tool forever (`src/qbo.js:326-356`).
- **Token-refresh races.** The recommended per-company-connector deployment runs many Node processes against shared `tokens.<slug>.json` files with no locking, no single-flight refresh, and non-atomic writes (`src/qbo.js:97-101`, `src/qbo.js:315-318`). Intuit rotates refresh tokens on each refresh; a lost race eventually forces re-authorization of a client's books.
- **Plaintext tokens with default permissions inside the project folder** users are told to keep on their Desktop (`src/qbo.js:41-44`, README setup). One zip-and-share of that folder leaks live access to every client's books. Skill guidance also routes production client secrets through chat and into the Claude Desktop config (`SKILL.md:53-56`, `SKILL.md:117-120`).
- **Stale API pinning and known-vulnerable dependencies.** `minorversion=70` is hardcoded (`src/qbo.js:23`); Intuit sunset minor versions 1-74 on August 1, 2025, so the pin is silently ignored today. `npm audit` reports 1 high and 2 moderate advisories, fixable with a version bump.

**Maturity scorecard:**

| Dimension | Rating | One-line reason |
|---|---|---|
| Product surface | Strong | 54 tools, reads and writes, multi-company, attachments, batch import |
| Safety design | Good | Write-gate and env separation are real; a few bypass edges remain |
| Security posture | Fair | Good instincts, but plaintext tokens, listener binding, escaping gaps |
| Reliability | Weak | No retry/backoff/timeout, truncation, refresh races, partial imports |
| Performance | Fair | Fine for single calls; N+1 lookups and verbose payloads at scale |
| Code quality | Fair | Readable, but one 1,660-line file, duplication, no types |
| Testing | Missing | Zero tests, no CI |
| Observability | Weak | stderr prints only; no correlation IDs, no audit log, no `intuit_tid` |
| Docs and onboarding | Strong | Excellent non-technical docs; two conflicting deployment stories |

---

## 2. Prioritized Improvement Roadmap

### Quick Wins (low effort, high impact; est. 1-3 days each)

**Status (2026-07-31): implemented on this branch after maintainer approval**, with two exceptions that stay open: the CI job (belongs with the medium-term test suite) and the Windows port of the registrar script (superseded by the unified-model docs rewrite).

- Update `MINOR_VERSION` to `75` and make it env-overridable (`src/qbo.js:23`). Versions 1-74 are sunset (Intuit, Aug 2025; see Sources).
- Bind both OAuth callback listeners to `127.0.0.1` instead of all interfaces (`src/qbo.js:236`, `src/qbo.js:469`).
- Write token files with mode `0600` and atomically (temp file + rename) (`src/qbo.js:97-101`). Interim step only; encrypted-at-rest storage is a committed requirement (see Decisions, section 15).
- Remove the Opzer marketing pointer from every error response and from README/SETUP_GUIDE copy (`src/index.js:119-125`). Decided: no vendor marketing in this deployment.
- Fix `esc()` to escape backslashes before quotes, and require `/^\d+$/` for every interpolated Id (`src/index.js:139-141`).
- `encodeURIComponent` every user-supplied path segment; `send_invoice_email` interpolates `invoice_id` raw (`src/index.js:903`) while sibling tools encode (`src/index.js:1120`, `src/index.js:1219`). Reject `..` in `api_request` paths (`src/index.js:1648-1653`).
- Add `AbortSignal.timeout(60_000)` to `fetch` calls; retry 429 and 5xx with exponential backoff honoring `Retry-After` (`src/qbo.js:326-356`).
- Single-flight token refresh per slug in-process; on refresh failure, re-read the token file once before failing (another process may have rotated it).
- Run `npm audit fix` (bumps `@modelcontextprotocol/sdk` past the `@hono/node-server` advisory and `fast-uri`); add a CI job for `npm audit` + a smoke test.
- Auto-paginate queries (STARTPOSITION loop) or, at minimum, return `truncated: true` whenever a result hits its MAXRESULTS cap (`src/index.js:553`, `src/index.js:576`, `src/index.js:1630`).
- Push the `get_invoices` status filter into the WHERE clause (`Balance > '0'`) instead of post-filtering a truncated page (`src/index.js:554-564`).
- Stop auto-creating vendors inside `create_bill`; require `create_if_missing: true` (`src/index.js:853-857`).
- Add a `health_check` tool per company: token validity, days to refresh expiry, environment, realm, one `companyinfo` round trip.
- Fix doc drift: SKILL.md says "16 tools" (`.claude/skills/add-qbo-company/SKILL.md:131`), actual is 54; the registrar script is macOS-only (`register_connector.py:24-28`) while the README promises Windows support.

### Medium-Term Improvements (est. 1-3 weeks each)

**Status (2026-07-31): implemented on this branch after maintainer approval**, with two scoped exceptions: the full TypeScript migration (helpers now live in focused modules; typing remains open) and the unified-model docs rewrite of SETUP_GUIDE and the bundled skill (tracked under Major).

- Local append-only write audit log (JSONL): timestamp, tool, company, realm, entity, Id, DocNumber, amount. Firms need this for engagement documentation. (Persistence approach approved; see Decisions.)
- Encrypted-at-rest token storage (required per Decisions): AES-256-GCM via `node:crypto`, master key in an OS secret store reached without native dependencies (macOS `security` CLI, Windows DPAPI via PowerShell), permission-restricted key file as fallback; includes migration from the plaintext files.
- CSV import idempotency: stamp each Purchase's `PrivateNote` with an import-batch marker, pre-check for duplicates, record an import journal, support resume. Also fix sign handling: `Math.abs()` on amounts turns bank credits into expenses (`src/index.js:952`), and raw CSV dates pass through unvalidated (`src/index.js:983`).
- First-class list/search read tools (`search_customers`, `get_accounts`, `get_bills`, ...) with case-insensitive matching and "did you mean" suggestions, replacing exact `DisplayName =` lookups (`src/index.js:205-224`).
- Class, Department/Location, and Project support on every line schema, plus tax (`TaxCodeRef`) on sales lines. Firms with class tracking cannot post correctly today.
- Complete the AP cycle: `create_bill_payment`, `create_transfer`, `get_bill_payments`.
- Change Data Capture tool (`get_changes_since`) using QBO's CDC endpoint; also powers cache invalidation.
- Structured, compact response shapes (Id, DocNumber, date, total, balance, names) with a `verbose` flag, instead of full raw QBO entities pretty-printed at 2-space indent (`src/index.js:114`).
- Capture the `intuit_tid` response header into every error and log line; it is what Intuit support asks for.
- Closing-date guardrail: read `Preferences.AccountingInfoPrefs.BookCloseDate`; warn or block writes dated on or before the close unless overridden.
- Token revocation on removal (`npm run disconnect -- <slug>` calling Intuit's revoke endpoint), replacing "delete the token file" guidance (`SKILL.md:149-150`).
- Test suite (vitest + undici MockAgent contract tests; unit tests for `esc`, `parseCSV`, `deriveSlugFromRealm`, `resolveCompany` precedence, journal balancing) and CI.
- Split `src/index.js` (1,660 lines) into domain modules; migrate to TypeScript or JSDoc + `tsc --checkJs`.

### Major Architectural Enhancements (quarter-scale)

**Status (2026-07-31): largely implemented on this branch.** Shipped: the unified deployment story (docs, skill, and cross-platform scripts rewritten; per-company connectors documented as legacy with migration notes), fleet operations (consolidated P&L and Balance Sheet, multi-company journal entries), the reconciliation and review toolkit (statement-vs-register matching, duplicate detection, flat GL with review flags), the per-company policy engine (read-only, amount ceiling, date floor, centrally enforced), and a 60-second name-index cache. Still open, deliberately: the full TypeScript migration, a semantic (embedding-based) entity index beyond the TTL cache, and any webhook relay (a local desktop process cannot receive Intuit webhooks; scheduled CDC polling via `get_changes_since` is the supported substitute).

**Benchmark adoption (2026-07-31):** after a comparison against Intuit's Apache-2.0-licensed [quickbooks-online-mcp-server](https://github.com/intuit/quickbooks-online-mcp-server) (the review originally said MIT; corrected 2026-08-02), the fork adopted its best patterns: registration-time verb kill switches (`QBO_DISABLE_WRITES`, `QBO_DISABLE_DELETES`), invoice and estimate PDF downloads, typed allowlisted search filters with sort, the missing balance/budget/tax/terms read surface, setup-entity writes (class, department, payment method, term), a single gated `delete_transaction` instead of their 20 delete tools, and a dotenv hardening fix for host-injected empty env values. Tool count is now 90. The comparison also confirmed this fork's differentiators (multi-company, encrypted tokens, retry/audit/guardrails, fleet and reconciliation tooling) have no equivalent in the official server.

- Unify the deployment story. **Decided 2026-07-31: unified is canonical.** The single `qbo` connector becomes the only documented path; SETUP_GUIDE and the `add-qbo-company` skill get rewritten to register one connector and rely on `select_company`/`company` arguments; per-company connectors are documented as legacy with a migration note. Locking design follows: in-process single-flight refresh plus atomic token writes cover the canonical path, with cross-process file locking kept as defense in depth for legacy installs and for `npm run connect` running beside a live server.
- Multi-company fleet operations: consolidated P&L/BS across companies, same JE posted to N companies, batch report packets. This is the feature no first-party tool offers and the strongest differentiator for firms.
- Reconciliation and anomaly toolkit: bank-CSV vs register diff, duplicate detection, Benford/outlier scans over GL exports shaped for LLM analysis.
- Local entity cache (accounts, items, customers, vendors) with CDC-driven refresh; enables fuzzy/semantic entity resolution and cuts most lookup traffic.
- Policy engine per company: read-only companies, write amount thresholds, allowed date windows, required memo/class. Firms will want per-client guardrails.
- Optional webhook relay or scheduled CDC polling for event-driven workflows (local desktop cannot receive Intuit webhooks directly).

---

## 3. Risk Assessment

| # | Issue | Severity | Likelihood | Impact | Recommended Fix |
|---|---|---|---|---|---|
| 1 | Query results silently truncated (100/500 caps, no truncation flag) | High | High | Wrong answers presented as complete (missed overdue invoices, understated lists) | Auto-pagination + `truncated` flag |
| 2 | No 429/retry/backoff/timeout handling | High | High | Bulk operations fail mid-run; hung sockets hang tools | Central retry wrapper, `Retry-After`, AbortSignal |
| 3 | Cross-process refresh-token race (per-company connectors, shared files, no locking) | High | Medium | Companies drop offline; forced re-auth of client books | Single-flight + atomic writes + re-read-on-fail |
| 4 | Plaintext tokens, default perms, stored in Desktop project folder | High | Medium | One shared zip or backup leaks live access to all client books | 0600 perms + relocation now; encrypted-at-rest storage required (see Decisions) |
| 5 | CSV import: `Math.abs()` on amounts, raw dates, no idempotency | High | Medium | Bank credits posted as expenses; duplicates on re-run | Sign-aware parsing, date normalization, import markers |
| 6 | `create_invoice` attaches all lines to an arbitrary Service item | Medium | High | Revenue misclassified to whatever income account that item carries | Require item or per-company default; surface choice |
| 7 | `minorversion=70` pinned; 1-74 sunset Aug 2025 | Medium | Certain | Pin is ignored; behavior drifted without a code change | Pin 75, env-overridable |
| 8 | `esc()` misses backslash escaping | Medium | Low | Crafted names break out of string literals; wrong-entity resolution can misdirect writes | Escape `\` then `'`; strict Id validation |
| 9 | Unencoded path segments + `api_request` path freedom | Medium | Low | Path traversal can retarget another connected realm, bypassing the company gate | Encode segments, reject `..`, validate path |
| 10 | OAuth listeners bind all interfaces | Medium | Low | LAN exposure of callback listener during auth | Bind `127.0.0.1` (RFC 8252 practice) |
| 11 | Production client secrets pasted into chat and stored in Desktop config | Medium | Medium | Secrets in conversation logs and un-gitignored config file | Keep secrets in `.env` only; never solicit in chat |
| 12 | Vendor auto-creation on `create_bill` typo | Medium | High | Phantom vendors, misfiled AP, list pollution | Opt-in flag + suggestions |
| 13 | Vulnerable transitive deps (1 high, 2 moderate per `npm audit`) | Medium | Low (stdio transport unused surface) | Supply-chain exposure; audit noise for firm IT | `npm audit fix`, CI audit, Dependabot |
| 14 | No token revocation on company removal | Medium | Medium | Offboarded client grants stay live server-side until expiry | Revoke endpoint + disconnect command |
| 15 | No write audit trail | Medium | Certain | Cannot answer "what did the AI post last month" | Local JSONL audit log |
| 16 | Legacy mode: writes proceed with zero named companies (`src/index.js:193`) | Low | Low | Contradicts "writes never auto-pick" claim in legacy single-file mode | Tighten or document |

---

## 4. Security Findings (prioritized)

### S1. Token storage: plaintext, default permissions, project-root location. **High.**
`saveTokens` writes JSON with default `0644`-style permissions into the repo root (`src/qbo.js:97-101`, `src/qbo.js:41-44`), the same folder docs tell users to keep on their Desktop and open in editors. Access + refresh tokens for every client's books live there. `.gitignore` covers `tokens*.json` (good), but backup tools, folder zips, screen shares, and multi-user machines do not read `.gitignore`.
**Remediation (updated per Decisions):** encrypted-at-rest storage is a requirement, not an option. Interim: write with `{ mode: 0o600 }` atomically and relocate token storage to a per-user data directory (`~/.config/qbo-mcp/` or platform equivalent) with a migration shim. Target: encrypt token files with AES-256-GCM via `node:crypto`, master key held in an OS secret store reached without native dependencies (macOS `security` CLI, Windows DPAPI via PowerShell), with a permission-restricted key file as fallback where no OS store exists.

### S2. Secret handling in the onboarding path. **Medium-High.**
The skill instructs users to paste production `QBO_CLIENT_SECRET` into the chat (`.claude/skills/add-qbo-company/SKILL.md:53-56`) and then writes it into `claude_desktop_config.json` via `--env` (`SKILL.md:117-120`, `register_connector.py:85`). That file is outside the project's `.gitignore` protection, is commonly synced/screenshotted, and now holds the highest-value secret. The script does redact the secret in its own stdout (`register_connector.py:96`), which is good.
**Remediation:** keep secrets only in `.env` (chmod 600); support multiple credential profiles in `.env` (e.g., `QBO_CLIENT_ID__PROD=`) instead of per-connector env blocks; change skill wording so users edit `.env` themselves rather than pasting secrets into conversation.

### S3. OAuth loopback listeners bind all interfaces. **Medium.**
`server.listen(port)` in both flows (`src/qbo.js:236`, `src/qbo.js:469`) binds `0.0.0.0`, exposing the callback listener to the local network for the duration of authorization. State validation (`src/qbo.js:174`, `src/qbo.js:455`) prevents code injection by strangers, but the listener still accepts LAN connections and, in batch mode, reveals authorization progress (409 "No authorization in progress", `src/qbo.js:451`).
**Remediation:** `server.listen(port, "127.0.0.1")`. Note: Intuit's OAuth is confidential-client (a client secret is required), so the secret-on-desktop model is forced by the platform; per-user Intuit app registration (which this project already assumes) is the right compensating design. Loopback redirect over `http://localhost` matches native-app practice (RFC 8252).

### S4. QBO query escaping is incomplete. **Medium.**
`esc()` escapes single quotes but not backslashes (`src/index.js:139-141`). A value ending in `\` produces `'...\'`, where the backslash consumes the closing quote and the remainder of the string becomes live query text. Every name-based lookup funnels through this (`src/index.js:205-224`, `src/index.js:292-300`). The blast radius is bounded by the accounting scope (queries read data the token can already read), but the sharper risk is wrong-entity resolution redirecting a subsequent write.
**Remediation:** `s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")`; validate all Id parameters as `/^\d+$/` before interpolation; add unit tests with hostile names.

### S5. Path traversal into sibling realms. **Medium.**
`send_invoice_email` interpolates `invoice_id` into the URL path unencoded (`src/index.js:903`); `api_request` accepts any path (`src/index.js:1648-1653`). WHATWG URL normalization means a crafted segment like `123/../../<other-realm>/invoice/1/send` retargets a different connected company on the same host, bypassing the company gate and its audit story. Sibling tools already encode correctly (`src/index.js:1120`, `src/index.js:1219`), so this is consistency, not architecture.
**Remediation:** encode every injected segment; reject `..` and validate `api_request` paths against `^\/[A-Za-z0-9][A-Za-z0-9\/_\-.?=&%,: ]*$`; log the final resolved URL for writes.

### S6. Arbitrary local file reads reachable by the model. **Medium.**
`attach_file` (`src/index.js:1605`) and `import_transactions_from_csv` (`src/index.js:922`) read any path the model supplies. Under prompt injection (a hostile email or document the user asks Claude to process), sensitive local files could be read into context or uploaded as QBO attachments visible to other users of that company file. Tool-permission settings ("needs approval" on writes, which the README recommends) are the current mitigation.
**Remediation:** default-restrict file access to a configured directory (`QBO_FILES_DIR`), require an explicit env opt-out for arbitrary paths, and reject reads of dotfiles/key material by default.

### S7. No token revocation on removal. **Medium.**
Removing a company is documented as deleting its token file (`SKILL.md:149-150`). The refresh token remains valid server-side until natural expiry. For a firm offboarding a client, the grant should be killed, not misplaced.
**Remediation:** add a `disconnect` command that calls Intuit's revoke endpoint, then deletes the file; document it as the offboarding step.

### S8. Vulnerable dependencies. **Medium (low exploitability today).**
`npm audit` (run 2026-07-31): `fast-uri` high (host confusion, GHSA-v2hh-gcrm-f6hx) and `@hono/node-server` moderate path traversal (GHSA-frvp-7c67-39w9) via `@modelcontextprotocol/sdk` 1.25.0-1.29.0. This connector uses stdio transport, not the SDK's HTTP server, so the vulnerable surface is not exercised, but pinned-vulnerable is the wrong resting state for firm IT review.
**Remediation:** `npm audit fix`; add CI audit gate and Dependabot/Renovate.

### S9. Governance gaps for firm use. **Medium.**
No per-company access control inside the connector (anyone at the machine reaches all client books), no write audit trail, and no consent surface for moving client data between contexts. These are inherent to the local single-user design but must be documented so firms can compensate with machine-level controls (disk encryption, OS accounts, tool permissions).

### Positive security observations

- OAuth `state` generated per attempt and enforced (both flows).
- Callback HTML is static; no query parameters are reflected (no XSS surface).
- Latest rotated refresh token is always persisted (`src/qbo.js:273-274`).
- Scope is minimal: `com.intuit.quickbooks.accounting` only (`src/qbo.js:22`).
- `sanitizeSlug` confines token filenames to safe characters (`src/qbo.js:34-36`).
- `.gitignore` covers `.env` and `tokens*.json` (`.gitignore:4-5`).
- `openBrowser`'s `exec` interpolation is currently safe because every URL component is percent-encoded or hex, but `spawn` with an args array would remove the class of risk (`src/qbo.js:130-143`).

---

## 5. Reliability Findings (prioritized)

- **R1. No throttle/retry/timeout layer.** `qboRequest` is a single naked `fetch` (`src/qbo.js:326-356`). Intuit enforces roughly 500 req/min per realm, 10 concurrent per app, ~40 batch req/min (see Sources), returning 429 + `Retry-After`. Every multi-line write already fans out lookups, so real workloads will throttle. Fix: one wrapper with exponential backoff + jitter, `Retry-After` honor, retry idempotent GETs on network errors, never blind-retry writes after a response was received, and `AbortSignal.timeout`.
- **R2. Refresh races.** In-process: two concurrent calls can both enter refresh (`src/qbo.js:315-318`). Cross-process: the per-company connector model plus shared default files means multiple Node processes rotate the same refresh token; last write wins and the loser's next refresh fails. Fix: per-slug single-flight promise; atomic token writes; on `invalid_grant`, re-read the file once (a sibling may hold the newer token) before surfacing re-auth guidance.
- **R3. Silent truncation.** Caps at `src/index.js:553` (100), `src/index.js:576` (500), `src/index.js:938` (200 expense accounts for categorization), `src/index.js:1630` (100 attachments), plus QBO's own default page size on raw `query`. Fix: pagination loops with a hard ceiling + explicit `truncated` and `total_available` (via `COUNT(*)`) in responses.
- **R4. CSV import correctness and idempotency.**
  - `Math.abs()` erases sign, so bank credits/refunds post as expenses (`src/index.js:952`).
  - Dates pass through raw; `07/31/2026` style strings reach `TxnDate` unvalidated (`src/index.js:983`).
  - Chunked batch posting (`src/index.js:995-999`) has no resume or duplicate guard; a mid-run failure then a re-run double-posts earlier chunks.
  - Categorization is first-word substring matching (`src/index.js:942-946`), which will misfile aggressively.
  Fix: sign-aware parsing with debit/credit column support, ISO date normalization with per-row validation in `dry_run`, import-batch markers in `PrivateNote` + pre-post duplicate query, an import journal file, and (medium-term) vendor-history-based categorization.
- **R5. Default-item invoice lines misclassify revenue.** All `create_invoice` lines attach to whatever Service item is found first (`src/index.js:810-818`); `buildSalesLines` has the same fallback (`src/index.js:342-343`). The item's income account drives P&L classification. Fix: require an item, or a per-company configured default; always echo the item used.
- **R6. Vendor auto-creation on `create_bill`** (`src/index.js:853-857`): typos mint phantom vendors and misfile AP. Fix: fail with fuzzy suggestions unless `create_if_missing: true`.
- **R7. Exact-match name resolution** (`DisplayName = '...'`) breaks on case/whitespace variants (`src/index.js:205-224`). Fix: case-insensitive fallback (QBO `LIKE`), then suggestions.
- **R8. Legacy write-gate edge:** with zero named companies, `resolveCompany` returns the legacy default even for writes (`src/index.js:193`), which quietly contradicts "write tools never auto-pick" (`src/index.js:10-11`). Fix or document.
- **R9. Docs promise "about 100 days" refresh life** (README, SECURITY.md, and the error at `src/qbo.js:309`). Intuit's November 2025 policy adds a 5-year hard maximum with unchanged 24-26h rotation; store `refresh_token_expiry` when returned and update copy (see Sources).
- **R10. `import_transactions_from_csv` advertises `Bill`/`JournalEntry` types it refuses to post** (`src/index.js:972-974`). Either implement or remove from the enum.
- **R11. No health/connection check tool**, so the first sign of a dead token is a failed real request. Add `health_check` (token status, expiry countdown, env, `companyinfo` ping).
- **R12. Slug edge case:** `listCompanies` accepts dotted filenames (`tokens.a.b.json`, regex at `src/qbo.js:116`) that `sanitizeSlug` can never select (`src/qbo.js:34-36`), yielding listed-but-unusable companies. Normalize both sides.

---

## 6. Performance Findings

- **P1. N+1 sequential lookups in line builders.** Each journal/sales/expense line resolves its account/item/entity with its own query, serially (`src/index.js:247-281`, `src/index.js:338-396`). A 20-line JE costs 20+ round trips before the write. Fix: de-duplicate names per request, resolve with bounded `Promise.all` (respect the 10-concurrent realm cap), and add a short-TTL per-company name→Id cache. Estimated effect: a 20-line JE drops from ~21 API calls to ~3-6; wall time roughly proportionally.
- **P2. Verbose payloads.** `asText` pretty-prints entire QBO responses (`src/index.js:114`). A year of General Ledger is megabytes of JSON fed to the model. Fix: compact JSON by default, `verbose` flag, encourage the existing GL `columns` parameter, and add summary shapes. This is the single biggest practical speed/cost win in Claude sessions.
- **P3. `listCompanies` filesystem scan per resolution.** Explicit-company calls re-read every token file (`src/index.js:178`, `src/qbo.js:107-128`). Cache with mtime check. Minor locally, tidy at 50 companies.
- **P4. Client-side attachment filtering** fetches 100 then filters (`src/index.js:1630-1634`); QBO cannot query `AttachableRef`, so pagination + documentation is the fix.
- **P5. Entity caching opportunity.** Accounts/items/customers/vendors are stable within a session; a 5-minute TTL cache (invalidated by CDC once added) removes most lookup traffic in interactive use.
- **P6. Non-issues worth stating:** stdio startup is trivial; Node 18+ `fetch` (undici) reuses connections by default; the 30-item batch chunking for CSV import matches Intuit's documented batch limit (`src/index.js:995`; see Sources).

---

## 7. Architecture and Code Quality Findings

- **A1. Monolith:** `src/index.js` is 1,660 lines holding 54 inline registrations plus helpers. Split into `src/tools/{company,reports,sales,purchases,journal,people,attachments,advanced}.js` with a small registry; keep `qbo.js` as the client layer and extract `companies.js` (resolution/gate) and `lines.js` (builders).
- **A2. No static types.** Zod guards inputs at runtime, but payload construction is stringly-typed. Migrate to TypeScript (or JSDoc + `tsc --checkJs` as a low-friction first step); type the QBO entity subset actually used.
- **A3. Duplicated OAuth exchange logic:** inline in `runAuthorizationFlow` (`src/qbo.js:187-217`) and again in `exchangeCodeForTokens` (`src/qbo.js:403-429`). Unify.
- **A4. Naming inconsistencies leak into the tool contract:** `transaction_date` (`src/index.js:846`, `src/index.js:1374`) vs `txn_date` everywhere else; `vendor_name` (name-only) vs `customer_ref` (name-or-Id); `lines` vs `line_items` vs `account_lines`. Standardize (accept old names as aliases for compatibility).
- **A5. Config scattered as constants:** `MINOR_VERSION`, scope, batch size, timeouts belong in one config module with env overrides.
- **A6. Version/count drift:** server version hardcoded twice (`package.json`, `src/index.js:431`); "54 tools" hardcoded in a log line (`src/index.js:1659`) and docs. Compute both.
- **A7. `sanitizeSlug` inconsistency with discovery regex** (see R12).
- **A8. `.gitignore` includes `*.mjs`** (`.gitignore:10`), which would silently hide future source files. Remove or scope it.
- **A9. Two deployment models** (unified `qbo` connector vs per-company `qbo-<slug>` connectors) are both half-documented; the skill hardwires one, the README pitches the other, and SKILL.md's tool count (16) matches neither. Choose one primary story.
- **A10. Platform gaps in the skill:** `config_path()` is macOS-only in both helper scripts (`register_connector.py:24-28`, `list_companies.py:19-22`) while the README onboards Windows users.

---

## 8. API Design Review

- **Responses:** raw QBO entities are returned verbatim. Define trimmed default shapes (Id, DocNumber, TxnDate, TotalAmt, Balance, display names, SyncToken) with `verbose: true` for full payloads. Keeps context small and answers consistent.
- **Error contract:** errors are prose plus a marketing pointer appended to every failure (`src/index.js:119-125`). Return structure (`code`, `message`, `intuit_tid`, `hint`) and remove the vendor CTA entirely (decided; see section 15). Promotional text in error paths trains users to ignore error bodies.
- **Read-surface symmetry:** writes exist for entities that have no dedicated reads (bills, payments, estimates, customers, vendors, items, accounts). The raw `query` tool technically covers this, but the audience is accountants; add `get_/search_` tools with filters and pagination. Also add a `get_query_schema` helper (entity + queryable-field hints) so the model writes valid QBO SQL on the first try.
- **Deletes/voids:** only `void_invoice` exists. Accountants also need JE delete, and void where QBO supports it; gate behind explicit flags.
- **`api_request` and permissions:** one tool spans arbitrary reads and writes (`src/index.js:1639-1654`). Anyone who sets it to "always allow" has allowed arbitrary writes, which undermines the recommended read/write permission split in README Step 9. Options: split into `api_get`/`api_post`, or annotate and document loudly.
- **MCP tool annotations:** the SDK level in use supports `registerTool` with annotations (`readOnlyHint`, `destructiveHint`, `title`). Adopting them lets Claude Desktop present and gate read vs write tools correctly instead of relying on docs.
- **Enum honesty:** `import_transactions_from_csv` advertises `Bill`/`JournalEntry` but rejects them at post time (`src/index.js:972-974`).
- **Versioning:** no CHANGELOG or semver discipline; tool contracts are user-facing APIs, so start both.

---

## 9. User Experience Review

- **Add `health_check` and `npm run doctor`:** env presence, redirect URI parse, port availability, Node version, token file status per company, one live `companyinfo` call. Most support threads end here.
- **Errors should carry next actions.** The token errors already do this well (`src/qbo.js:296-313`); extend the pattern: 401 → reconnect command for that slug; 403 → scope/permissions; 429 → "throttled, retried N times, waiting Xs".
- **Company confirmation by name, not slug.** `select_company` returns the slug/realm (`src/index.js:449-463`); echo the QBO `CompanyName` and environment so "work on 8315" confirms as the human-readable client name. Cheap, and it strengthens the wrong-books story.
- **Environment visibility on writes:** include `environment: production` in every write response so a sandbox/production mixup is visible at the moment it matters.
- **Truncation honesty** (R3) is also UX: "showing 100 of 342" keeps trust.
- **Onboarding:** consolidate the two deployment models; add a copy-paste Windows path for the registrar or port it; keep the excellent plain-language docs, they are a genuine asset.

---

## 10. Observability Review

Current state: unstructured stderr prints (`src/index.js:36`, `src/qbo.js:28-30`), no correlation IDs, no `intuit_tid` capture, no audit trail, no diagnostics surface.

Recommended (all local, privacy-preserving):

- Structured JSONL logs behind `QBO_LOG=json|text|off` to a rotating file in the data dir; never log tokens or full payload bodies by default.
- Per-tool-call correlation ID; include it in error text so a user can quote it.
- Capture `intuit_tid` from every response and attach it to errors and logs; it is the key Intuit support asks for.
- Append-only write audit log (see roadmap): every write tool call with company, realm, entity, Id, DocNumber, amount, and result. This doubles as the firm's engagement documentation for AI-performed work.
- `get_diagnostics` tool: version, Node version, companies with token expiries, last 5 errors, audit-log location.

---

## 11. Testing Strategy

Current state: zero tests, no CI, no lint config.

- **Unit (fast, first):** `esc` (hostile names incl. trailing backslash), `parseCSV` (quotes, CRLF, BOM, embedded newlines), `deriveSlugFromRealm` collisions, `resolveCompany` precedence and write-gate (including the legacy zero-company edge), journal balancing (floats, 0.005 tolerance boundaries), `sanitizeSlug`/discovery-regex agreement.
- **Contract tests:** undici `MockAgent` fixtures for token exchange, refresh (incl. rotation and `invalid_grant`), 429 with `Retry-After`, 5xx, fault-shape parsing, batch partial failures. These pin the Intuit wire contract without network.
- **Integration (opt-in, sandbox creds):** a tagged suite that runs the full lifecycle against an Intuit sandbox: create customer → invoice → payment → void; CSV dry-run vs live; attachment upload.
- **Security tests:** slug traversal attempts, path traversal on `api_request` and Id parameters, injection corpus through every name-based tool.
- **Resilience tests:** kill the network mid-batch-import and assert the journal/resume behavior once built.
- **CI:** GitHub Actions running lint + unit/contract tests + `npm audit` on PRs.

---

## 12. QuickBooks Best Practices Compliance

| Practice | Status | Evidence / action |
|---|---|---|
| Minor version pinned and current | **Fail** | `minorversion=70` (`src/qbo.js:23`); 1-74 sunset 2025-08-01, requests behave as 75 regardless. Pin 75. |
| Rate limits + `Retry-After` handling | **Fail** | No 429 handling anywhere. Add backoff. |
| Store latest rotated refresh token | **Pass** | `src/qbo.js:273-274`. |
| Refresh-token 5-year policy awareness | **Gap** | Code computes expiries from response fields (good) but docs/errors still say "100 days" only. |
| Pagination (STARTPOSITION/MAXRESULTS) | **Fail** | No pagination loops; silent caps. |
| Batch endpoint usage and 30-item limit | **Pass** | CSV import batches 30 (`src/index.js:995`). |
| Change Data Capture | **Missing** | No CDC tool; add `get_changes_since`. |
| Webhooks | **N/A (documented?)** | Local desktop cannot receive them; document the limitation, offer CDC polling. |
| Sandbox/production separation | **Pass** | Per-token-file environment → host (`src/qbo.js:77-82`). |
| Scope minimization | **Pass** | Accounting scope only (`src/qbo.js:22`). |
| OAuth state validation | **Pass** | Both flows. |
| Loopback binding for native-app OAuth | **Partial** | Listener not restricted to `127.0.0.1`. |
| `intuit_tid` capture for support | **Fail** | Never read. |
| Official SDK usage | **Deliberate no** | Hand-rolled client is acceptable at this size; the retry/refresh gaps are what the official libs would have covered, so closing them matters more. |

---

## 13. Feature Backlog

Effort figures are estimates for one experienced developer, flagged as such.

| # | Feature | Description | Business value | Complexity | Est. effort | Dependencies |
|---|---|---|---|---|---|---|
| F1 | Bill payments + transfers | `create_bill_payment` (check/CC), `create_transfer`, `get_bill_payments` | Completes the AP cycle; today you can enter a bill but never pay it | Low-Med | 2-4 days | Ref resolution |
| F2 | Class/location/project dimensions | `ClassRef`, `DepartmentRef`, project tagging on all line schemas | Firms with class tracking cannot post correctly at all today | Med | 4-6 days | Line builder refactor |
| F3 | Sales tax support | `TaxCodeRef` per line, `TxnTaxDetail` handling | Invoices currently post untaxed; blocking for taxable-sales clients | Med | 4-6 days | F2 refactor helpful |
| F4 | Search/list read tools | `search_customers/vendors/items/accounts`, `get_bills/payments/estimates` with filters + pagination | Discoverability and safety for non-engineers; removes raw-SQL dependence | Low | 3-5 days | Pagination layer |
| F5 | Invoice/estimate PDF download | GET `/invoice/{id}/pdf` to local file | Client-ready documents in one step; high delight | Low | 1 day | None |
| F6 | Estimate → invoice conversion | Create invoice with `LinkedTxn` from an accepted estimate | Extremely common workflow | Low | 1-2 days | None |
| F7 | Change Data Capture | `get_changes_since(entities, since)` via `/cdc` | "What changed in this file this week" for close and review workflows; cache invalidation | Low-Med | 2-3 days | None |
| F8 | Closing-date guardrail | Read `Preferences`; warn/block writes on or before `BookCloseDate` | Prevents the classic reopened-period disaster; a firm-trust feature | Low | 1-2 days | None |
| F9 | Write audit log | Local JSONL of every write with company/entity/amount | Engagement documentation of AI-performed work | Low | 2 days | None |
| F10 | JE reversal | One-call reversing entry from an existing JE | Accountant staple | Low | 1 day | None |
| F11 | Duplicate detection | Pre-write check for same vendor+amount+date bill/expense; warn | Catches double entry, the most common bookkeeping defect | Low-Med | 2-3 days | F4 |
| F12 | CSV import v2 | Sign-aware amounts, debit/credit columns, date normalization, idempotent resume, vendor-history categorization | Makes the flagship feature safe on real bank files | Med | 5-8 days | R4 fixes |
| F13 | Attachment download | Fetch `TempDownloadUri` content to local file | Completes the document loop (read side of `attach_file`) | Low | 1 day | None |
| F14 | Reports expansion | P&L by class, P&L detail, sales by customer/item, inventory valuation, customer/vendor balance detail, budget vs actual (Budget entity read) | Thin wrappers; big accountant surface | Low | 0.5 day each | None |
| F15 | Recurring transactions | Read `RecurringTransaction` templates; create instances | Month-end automation building block | Med | 3-4 days | None |
| F16 | Multi-company consolidated reporting | Normalized P&L/BS rollup across selected companies | The firm-level differentiator; nothing first-party does this | Med-High | 1-2 weeks | Pagination, caching |
| F17 | Per-company policy config | Read-only companies, amount thresholds, date windows, required fields | Enterprise trust and safe delegation | Med | 1 week | Config module |
| F18 | Generic `execute_batch` | Expose QBO batch (30 ops) for power users | Bulk edits at 1/30th the request count | Low | 1-2 days | None |
| F19 | Payroll | Out of scope: Intuit's accounting API does not expose payroll runs | n/a | n/a | n/a | Use a payroll-native integration |
| F20 | Inventory adjustments | Not supported by the QBO v3 API (quantity set at item creation only); document the boundary | Prevents dead-end user attempts | n/a | docs only | None |

---

## 14. Future Roadmap (beyond the backlog, prioritized by expected customer value)

- **Close automation.** A `run_close_checklist` capability: CDC since last close, unreconciled balances via reports, missing-attachment scan, draft adjusting entries for approval. Highest willingness-to-pay in accounting firms.
- **Reconciliation assist.** Bank CSV vs QBO register diff with propose/approve flow. Pairs with CSV import v2; mostly local computation, no new API surface.
- **Anomaly and audit scans.** Shape GL/transaction exports for LLM review: outliers, weekend/backdated postings, round-number clusters, duplicate candidates, Benford screens. The connector's job is compact, well-structured data; Claude does the reasoning.
- **Learned categorization.** Build vendor→account priors from the company's own history to replace first-word matching; explainable suggestions with confidence.
- **Semantic entity resolution.** Local index of names/addresses (refreshed via CDC) so "the plumber in Longview" resolves reliably; removes the exact-match failure class entirely.
- **Fleet operations.** Same JE across N companies, batch report packets per client, cross-company AR sweep. Builds on F16.
- **Event-driven mode.** Optional relay service or scheduled CDC polling to approximate webhooks locally; enables "tell me when a client's books change".
- **Natural-language query hardening.** `get_query_schema` plus curated examples so the model writes correct QBO SQL first-try; cheap, immediately compounding.

---

## 15. Decisions (answered by the maintainer, 2026-07-31)

The open questions from the initial review were resolved as follows. The affected recommendations in sections 2, 3, 4, and 8 were updated to match.

- **Deployment model: unified is canonical.** One `qbo` connector; the company is selected at runtime. Per-company connectors become a documented legacy mode with a migration path. Consequences: the docs rewrite keeps README as the primary story and re-targets SETUP_GUIDE plus the bundled skill to register a single connector, and the locking design centers on in-process single-flight refresh with atomic token writes, keeping cross-process locking as defense in depth.
  - Follow-on recommendation (reviewer inference, confirm before implementing): with unified canonical, writes should require an explicit `company` argument or a `select_company` session default, and `QBO_COMPANY` should count only for reads in legacy installs.
- **Distribution: internal per-firm use, possibly shared with peer firms.** No Intuit marketplace review applies; each installing firm keeps registering its own Intuit app, which also avoids shared-secret distribution. Because sharing is anticipated: keep the repo free of firm data, and note that the repository currently has **no LICENSE file**. Unlicensed code is all-rights-reserved by default, so add a license (or an explicit internal-use notice) before sharing outside the firm.
- **Vendor marketing: remove entirely.** The Opzer pointer appended to every tool error (`src/index.js:119-125`) and the promotional copy in README/SETUP_GUIDE are to be removed, not made configurable.
- **Token storage: secure storage is required** (an OS keychain specifically is not mandated). File permissions plus relocation are interim hardening only. Target design: AES-256-GCM encryption of token files via `node:crypto`, master key in an OS secret store reached without native dependencies (macOS `security` CLI, Windows DPAPI via PowerShell), permission-restricted key file as fallback. Apply the same pattern to `.env` client credentials once tokens are done.
- **Local persistence: approved.** JSONL first (write audit log, CSV import journal): no new dependency, append-only, greppable. Adopt SQLite only when query needs justify it (entity cache, semantic index), preferring the built-in `node:sqlite` module once the supported Node floor reaches a version where it is stable, rather than a native npm dependency.

### Still open (updated after the major-tier batch)

- **`api_request` posture: resolved.** A read-only `api_get` tool was added so permission settings can always-allow reads while `api_request` (which can POST) stays behind approval; documented in README Step 9.
- **The `sandbox-backup` special case: resolved 2026-08-04.** Replaced by a `backups/` directory convention: discovery reads the project root only, so a token file parked in `backups/` is retained and never listed. The magic slug is gone; a legacy file of that name now triggers a one-line migration notice instead of being silently hidden.
- **License: resolved 2026-08-02.** Apache-2.0 (LICENSE, NOTICE, CONTRIBUTING.md), matching Intuit's server. The original author (Isaac/Opzer) gave permission to modify and extend; attribution preserved in NOTICE.

---

## 16. Sources

Code references are to commit `11f9504` of this repository. External facts:

- Intuit Developer: minor versions 1-74 deprecated August 1, 2025; requests default to 75: [Changes to our Accounting API that may impact your application](https://medium.com/intuitdev/changes-to-our-accounting-api-that-may-impact-your-application-c330bd1a06f5); secondary summaries: [Codat](https://docs.codat.io/updates/250219-qbo-minor-versions-update/), [Boomi](https://community.boomi.com/s/article/QuickBooks-Online-Accounting-API-defaults-to-Minor-Version-75).
- Intuit rate limiting (≈500 req/min per realm, 10 concurrent per app, batch ≈40/min, 429 + Retry-After): [Intuit developer help: QBO API throttling and rate limiting](https://help.developer.intuit.com/s/question/0D5TR00000oMNgN0AW/qbo-api-throttling-and-rate-limiting); overview guides: [Coefficient](https://coefficient.io/quickbooks-api/quickbooks-api-rate-limits), [Satva Solutions](https://satvasolutions.com/blog/quickbooks-online-api-limitations-guide).
- OAuth token lifetimes (access 60 min; refresh rotates each 24-26h; 100-day inactivity; 5-year maximum validity from the November 2025 policy, production effective January 27, 2026): [Handling OAuth token expiration](https://help.developer.intuit.com/s/article/Handling-OAuth-token-expiration), [Validity of Refresh Token](https://help.developer.intuit.com/s/article/Validity-of-Refresh-Token), [Important changes to refresh token policy](https://blogs.intuit.com/2025/11/12/important-changes-to-refresh-token-policy).
- Batch operation limit (30 items): [Intuit API reference, Batch](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/batch).
- Change Data Capture: [Intuit API reference, ChangeDataCapture](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/changedatacapture).
- Dependency advisories (from `npm audit`, 2026-07-31): [GHSA-frvp-7c67-39w9 (@hono/node-server)](https://github.com/advisories/GHSA-frvp-7c67-39w9), [GHSA-v2hh-gcrm-f6hx (fast-uri)](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx).
- Native-app OAuth loopback guidance: [RFC 8252, OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252).
