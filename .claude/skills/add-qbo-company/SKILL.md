---
name: add-qbo-company
description: >-
  Connect an additional QuickBooks Online company (a second/third "accounting
  file" or realm) to this local qbo-mcp-server. The unified model means every
  authorized company is reachable through the single `qbo` connector; adding a
  company is authorize-and-go, with no restart after the first setup. Use this
  whenever the user wants to add, connect, hook up, onboard, or authorize
  another QBO company / client / business / sandbox / production file;
  phrasings like "add another company", "connect a second QuickBooks", "hook up
  my client's books", "authorize a new realm", "set up production QBO", or "I
  need both companies at once". Also use it to check which companies are wired
  up, or to remove (disconnect) one. Prefer it over hand-running npm run
  connect or hand-editing the Claude Desktop config.
---

# Add a QBO company

This server talks to many QuickBooks companies through **one** `qbo` connector.
Each company is a `tokens.<slug>.json` file (credentials encrypted at rest); the
company is chosen at runtime with `select_company` or a per-call `company`
argument. Adding a company has two moving parts, and only the first needs a
human:

1. **Authorize**: a browser login to Intuit that writes `tokens.<slug>.json`.
2. **Register (first time only)**: make sure the single `qbo` connector exists
   in the Claude Desktop config. Once it does, new companies are live the
   moment they're authorized, with no restart.

## Before you start

Confirm you're operating on this project. Resolve `PROJECT_DIR` (the
`qbo-mcp-server` folder, e.g. `~/Desktop/qbo-mcp-server`) and `NODE` (absolute
node path via `which node`, since Claude Desktop can't rely on `$PATH`). Use
absolute paths everywhere; the Claude Desktop config requires them.

## Step 1: Gather the details

Ask the user (don't guess; a wrong environment silently hits the wrong API, and
a bad slug creates a phantom company):

- **Slug**: a short, lowercase, `a-z0-9-` label (e.g. `8315`, `acme`,
  `client-bakery`). This becomes the token filename and the name used in
  `select_company`. Keep it stable.
- **Environment**: `sandbox` or `production`. If the user is unsure and it's a
  real business, it's production.
- **For production only**: that app's own `QBO_CLIENT_ID` and
  `QBO_CLIENT_SECRET`, since sandbox keys can't reach production. Have the user
  put them in `.env` themselves (or use per-run env overrides); do not ask them
  to paste secrets into the conversation, and **never type the user's Intuit
  login yourself**; that's theirs to enter in the browser.

Sanity-check the current state first:
```bash
python3 .claude/skills/add-qbo-company/scripts/list_companies.py --project-dir "$PROJECT_DIR"
```
If the slug already shows as authorized, re-running connect refreshes it in
place; confirm that's the intent.

## Step 2: Authorize (the human's part)

Run the connect flow with `QBO_COMPANY` set so tokens land in the right file.
Run it **in the background**; it starts a localhost:3000 listener and blocks
until the browser callback arrives.

```bash
cd "$PROJECT_DIR" && QBO_COMPANY=<slug> npm run connect
```

Adding several at once? Use the batch flow (log in once, pick + Allow each):
```bash
cd "$PROJECT_DIR" && npm run connect:batch
```

**Production companies cannot use the localhost flow** (Intuit rejects
localhost redirect URIs outside the development environment). Use either
working path; both verify the landed company and store tokens encrypted:

```bash
# RECOMMENDED: Intuit's OAuth 2.0 Playground. Paste back the Realm ID and
# Refresh Token (input hidden); every hop stays on Intuit-operated pages and
# there is nothing to host. One-time setup: add
# https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl as a Redirect
# URI on the app's PRODUCTION keys page, and in the playground pick the SAME
# app whose keys are in this project's .env, or the paste fails invalid_grant.
cd "$PROJECT_DIR" && npm run connect:playground -- <slug>

# ALTERNATIVE: a catcher page you host yourself. Requires
# QBO_CATCHER_REDIRECT_URI in .env pointing at your own deployed copy of
# docs/oauth-catcher/index.html, registered on the Intuit app. The flow
# refuses to run without it; there is no default page.
cd "$PROJECT_DIR" && npm run connect:catcher -- <slug>
```

The connect flow tries to auto-open the browser, but don't rely on that alone.
Read the command's output a second or two after launching, lift the URL between
the `AUTHORIZE_URL>>> ... <<<` delimiters, and present it as a clickable link:
> Your browser should open to Intuit. If it doesn't, click this link, log into
> the company you want, pick the right one if prompted, and click **Allow**.
> You'll see "QuickBooks connected"; close that tab.

Only one `connect` can run at a time (they all use port 3000); never launch two
in parallel.

**Checkpoint**: confirm the token file was written with the expected
realm/environment:
```bash
python3 .claude/skills/add-qbo-company/scripts/list_companies.py --project-dir "$PROJECT_DIR"
```
The new slug should read `AUTHORIZED=yes` with the right `ENV`. If token
exchange failed for a production company, it's almost always sandbox keys or an
unregistered redirect URI; see
[references/troubleshooting.md](references/troubleshooting.md).

## Step 3: Ensure the unified connector exists (first time only)

If `list_companies.py` says the unified connector is missing, register it:
```bash
python3 .claude/skills/add-qbo-company/scripts/register_connector.py \
  --project-dir "$PROJECT_DIR" --node "$NODE"
```
The script backs up the config, refuses to touch corrupt JSON, and is
idempotent. It registers ONE `qbo` entry with no per-company env; the company
is picked at runtime.

**Checkpoint**: `list_companies.py` should now show `unified connector: yes`.

## Step 4: Restart only if the connector was just created

- Connector already existed: **no restart**. The new company is live now; prove
  it with the `health_check` or `list_companies` tool in Claude Desktop.
- Connector newly registered: Claude Desktop needs one full relaunch (**Quit**
  with Cmd-Q, not just closing the window) to load it.

## Wrap up

Summarize for the user: the slug, its realmId and environment, and that they
select it with *"work on <slug>"* (or a `company` argument on any call). If they
added a production company, remind them those are **real** books; writes post
for real, and per-company guardrails can be set in `qbo-policy.json`.

## Related tasks

- **Switch companies while working**: just say *"work on <slug>"*
  (`select_company`); nothing to reconfigure.
- **Remove a company**: `npm run disconnect -- <slug>`. This revokes the OAuth
  grant with Intuit and deletes the token file, which is the complete
  offboarding step. If a legacy `qbo-<slug>` connector entry exists, remove it
  from the config too.
- **Legacy per-company connectors** (`qbo-<slug>` entries with `QBO_COMPANY`
  baked in): they still work, but the unified connector replaces them. To
  migrate, register the unified connector once, remove the per-company entries,
  and restart Claude Desktop.
- **Deeper failures** (port in use, refresh-token expiry, wrong realm): see
  [references/troubleshooting.md](references/troubleshooting.md).
