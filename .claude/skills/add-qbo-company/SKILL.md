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

Confirm you're operating on this project and choose commands for the user's
actual shell. Resolve absolute `PROJECT_DIR`, `NODE`, and `PYTHON` paths;
Claude Desktop cannot rely on the interactive shell's `PATH`.

macOS/Linux (bash/zsh):
```bash
PROJECT_DIR="$(cd ~/Desktop/qbo-mcp-server && pwd)"
NODE="$(command -v node)"
PYTHON="$(command -v python3 || command -v python)"
```

Windows PowerShell:
```powershell
$PROJECT_DIR = (Resolve-Path "$env:USERPROFILE\Desktop\qbo-mcp-server").Path
$NODE = (Get-Command node -ErrorAction Stop).Source
$pythonCommand = Get-Command py -ErrorAction SilentlyContinue
if (-not $pythonCommand) { $pythonCommand = Get-Command python -ErrorAction Stop }
$PYTHON = $pythonCommand.Source
```

If the project lives elsewhere, use its real path. Do not translate the
PowerShell examples into Unix environment-prefix syntax.

## Step 1: Gather the details

Ask the user (don't guess; a wrong environment silently hits the wrong API, and
a bad slug creates a phantom company):

- **Slug**: a short, lowercase, `a-z0-9-` label (e.g. `acme`, `northwind`,
  `client-bakery`). This becomes the token filename and the name used in
  `select_company`. Keep it stable.
- **Environment**: `sandbox` or `production`. If the user is unsure and it's a
  real business, it's production.
- **For production only**: that app's own `QBO_CLIENT_ID` and
  `QBO_CLIENT_SECRET`, since sandbox keys can't reach production. Have the user
  put them in `.env` themselves (or use per-run env overrides); do not ask them
  to paste secrets into the conversation, and **never type the user's Intuit
  login yourself**; that's theirs to enter in the browser.

Sanity-check the current state first.

macOS/Linux:
```bash
cd "$PROJECT_DIR" && npm run doctor
"$PYTHON" .claude/skills/add-qbo-company/scripts/list_companies.py --project-dir "$PROJECT_DIR"
```

Windows PowerShell:
```powershell
Set-Location $PROJECT_DIR
npm run doctor
& $PYTHON "$PROJECT_DIR\.claude\skills\add-qbo-company\scripts\list_companies.py" --project-dir $PROJECT_DIR
```
`doctor` must not print secrets or contact Intuit. Resolve any credential-pair,
policy, token-permission, or `QBO_FILES_DIR` error before continuing.
If the slug already shows as authorized, stop and confirm the user intends to
reauthorize that same realm/environment. Existing slugs require explicit
replacement authority: add `-- --replace-existing` to the sandbox command or
`--replace-existing` to the production Playground/catcher command. A different
realm or environment must use a new slug; replacement deliberately refuses it.

## Step 2: Authorize (the human's part)

Choose exactly one flow below. The three flows have different output markers
and human handoffs; do not treat them as interchangeable.

### Sandbox: localhost callback

Set `QBO_COMPANY` so tokens land in the right file. This command starts a
localhost:3000 listener and blocks until the browser callback arrives. If an
agent launches it, use a background terminal task so its output remains
visible; a user running it in their own terminal can leave it in the foreground.

macOS/Linux:
```bash
cd "$PROJECT_DIR" && QBO_COMPANY=<slug> npm run connect
```

Windows PowerShell:
```powershell
Set-Location $PROJECT_DIR
$env:QBO_COMPANY = "<slug>"
npm run connect
Remove-Item Env:QBO_COMPANY -ErrorAction SilentlyContinue
```

Read the command output for `AUTHORIZE_URL>>> ... <<<` and give that URL to the
user if the browser did not open. They log into the intended sandbox company,
click **Allow**, and may close the tab after it shows **QuickBooks connected**.

Adding several sandbox companies at once? From the project directory use the
batch flow (log in once, then pick + Allow each). It also uses localhost:3000
and emits `AUTHORIZE_URL>>> ... <<<` for each company:
```bash
npm run connect:batch
```

### Production: Intuit OAuth Playground (recommended)

Production companies cannot use the localhost flow. Run this command in the
foreground because it waits for interactive terminal input:

```bash
npm run connect:playground -- <slug>
```

It emits `PLAYGROUND_URL>>> ... <<<`, not `AUTHORIZE_URL>>>`. Open that URL and
follow the numbered Playground instructions printed by the command. One-time
setup: add
`https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl` to the app's
**Production** Redirect URIs. In the Playground select the same app whose
production keys are in this project's `.env`, authorize the intended company,
and click **Get tokens**. The running command then prompts:

- `Paste the Realm ID:`
- `Paste the Refresh Token (input hidden):`

The user must paste both directly into that terminal. Never ask them to put the
refresh token in the conversation or echo it back. The command exchanges,
encrypts, verifies, and reports the authorized company when complete.

### Production alternative: hosted catcher

This requires `QBO_CATCHER_REDIRECT_URI` in `.env` to point at the user's own
deployed copy of `docs/oauth-catcher/index.html`, registered on the same Intuit
app. Run in the foreground:

```bash
npm run connect:catcher -- <slug>
```

This flow emits `AUTHORIZE_URL>>> ... <<<`. After the user authorizes, the
catcher page says **QuickBooks authorization caught** and provides a copy
button. Paste the line from the catcher page directly into the running command
at `Paste the line from the catcher page here:`. The command verifies OAuth
state, exchanges the one-time code, verifies the company, and then reports the
authorized realm.

Only the sandbox localhost and batch flows use port 3000. Run authorizations
sequentially anyway so the human can verify each returned company before the
next slug is touched.

**Checkpoint**: confirm the token file was written with the expected
realm/environment:

macOS/Linux:
```bash
"$PYTHON" .claude/skills/add-qbo-company/scripts/list_companies.py --project-dir "$PROJECT_DIR"
```

Windows PowerShell:
```powershell
& $PYTHON "$PROJECT_DIR\.claude\skills\add-qbo-company\scripts\list_companies.py" --project-dir $PROJECT_DIR
```
The new slug should read `AUTHORIZED=yes` with the right `ENV`. If token
exchange failed for a production company, it's almost always sandbox keys or an
unregistered redirect URI; see
[references/troubleshooting.md](references/troubleshooting.md).

## Step 3: Ensure the unified connector exists (first time only)

If `list_companies.py` says the unified connector is missing, register it:

macOS/Linux:
```bash
"$PYTHON" .claude/skills/add-qbo-company/scripts/register_connector.py \
  --project-dir "$PROJECT_DIR" --node "$NODE"
```

Windows PowerShell:
```powershell
& $PYTHON "$PROJECT_DIR\.claude\skills\add-qbo-company\scripts\register_connector.py" --project-dir $PROJECT_DIR --node $NODE
```
The script backs up the config, refuses to touch corrupt JSON, and is
idempotent. It registers ONE `qbo` entry with no per-company env; the company
is picked at runtime.

**Checkpoint**: `list_companies.py` should now show `unified connector: yes`.

## Step 4: Restart only if the connector was just created

- Connector already existed: **no restart**. The new company is live now; prove
  it with the `health_check` or `list_companies` tool in Claude Desktop.
- Connector newly registered: Claude Desktop needs one full relaunch to load
  it. On macOS use **Quit** / Cmd-Q; on Windows exit Claude Desktop completely
  (including its tray process if present), then reopen it.

## Wrap up

Summarize for the user: the slug, its realmId and environment, and that they
select it with *"work on <slug>"* (or a `company` argument on any call). If they
added a production company, remind them those are **real** books; writes post
for real, and per-company guardrails can be set in `qbo-policy.json`.

## Related tasks

- **Switch companies while working**: `select_company` remains convenient for
  reads. Every write must still carry the explicit slug; never treat the active
  read selection as posting authority.
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
