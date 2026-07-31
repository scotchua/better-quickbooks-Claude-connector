# Troubleshooting: adding a QBO company

Read this when a step in `SKILL.md` fails. Each entry is symptom → cause → fix.

## "Token exchange failed" during `npm run connect`

Almost always a mismatch between the app you're authorizing against and the keys
in use.

- **Production company, sandbox keys.** Sandbox `QBO_CLIENT_ID/SECRET` cannot
  mint production tokens. Re-run with production keys and
  `QBO_ENVIRONMENT=production` (see SKILL step 2).
- **Redirect URI not registered.** The exact URI `http://localhost:3000/callback`
  must be listed under the app's Redirect URIs in the Intuit developer portal —
  and on the *same* app (sandbox vs production keys have separate redirect lists).
- **State mismatch — possible CSRF.** A stale browser tab replayed an old
  callback. Close all localhost:3000 tabs and re-run connect fresh.

## Browser didn't open

`openBrowser` (`src/qbo.js`) shells out to `open`. If it's blocked, the command's
stderr prints the full authorize URL — have the user paste it into a browser
manually. Everything else is unchanged.

## `EADDRINUSE` / port 3000 already in use

Another `connect` (or an unrelated process) holds port 3000. Only one connect can
run at a time. Find and stop it:
```bash
lsof -i :3000        # identify the PID
kill <pid>           # stop it, then re-run connect
```

## Company authorized but tools return nothing / wrong data in Claude Desktop

- **Unified connector missing.** Run `list_companies.py`; if it says
  `unified connector: NO`, register it once with `register_connector.py` and do
  a full relaunch (Cmd-Q). After that first registration, new companies need no
  restart; verify with the `health_check` or `list_companies` tool.
- **First-registration restart skipped.** A newly added connector entry loads
  only on a full relaunch. Closing the window isn't enough.
- **Legacy setup, wrong slug.** In old per-company setups, the `env.QBO_COMPANY`
  in the config must match the `tokens.<slug>.json` filename exactly.
  `list_companies.py` shows legacy connectors in their own column.

## "Refresh token expired"

Intuit refresh tokens expire after roughly 100 days of disuse (and carry a
5-year maximum validity). Re-authorize that one company:
`QBO_COMPANY=<slug> npm run connect`. No config change or restart needed; the
token file is refreshed in place.

## Offboarding a client

Deleting the token file alone leaves the OAuth grant live on Intuit's side. Use
`npm run disconnect -- <slug>`, which revokes the grant first and then removes
the file.

## Wrong company's data appearing

Two connectors point at the same `realmId`, or a token file was copied without
re-authorizing. Run `list_companies.py`; if two slugs share a realmId, re-run
connect for the one that's wrong so it captures the intended company.

## Claude Desktop config got corrupted

`register_connector.py` refuses to write over invalid JSON and always backs up
first (`claude_desktop_config.json.bak-<timestamp>`). Restore the most recent
`.bak-*` file, fix the JSON, and re-run the script.
