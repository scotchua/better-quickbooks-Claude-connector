# Troubleshooting: adding a QBO company

Read this when a step in `SKILL.md` fails. Each entry is symptom → cause → fix.

## "Token exchange failed" during authorization

Almost always a mismatch between the app you're authorizing against and the keys
in use.

- **Wrong app or environment.** Sandbox and production credentials are separate.
  Sandbox uses `QBO_COMPANY=<slug> npm run connect`; production must use
  `npm run connect:playground -- <slug>` or the configured HTTPS catcher. The
  localhost command explicitly refuses production.
- **Redirect URI not registered.** Sandbox localhost requires the exact
  `http://localhost:3000/callback`. Production Playground requires
  `https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`; the catcher
  requires its configured HTTPS URL. Register the applicable URI on the same
  app/environment whose keys are in `.env`.
- **State mismatch — possible CSRF.** A stale browser tab replayed an old
  callback. Close all localhost:3000 tabs and re-run connect fresh.

## Browser didn't open

The platform browser launcher may be blocked. The command's stderr prints the
full authorize URL — have the user paste it into a browser manually. Everything
else is unchanged.

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

Re-authorize that same company with the flow matching its environment:

- sandbox: `QBO_COMPANY=<slug> npm run connect -- --replace-existing`
- production: `npm run connect:playground -- <slug> --replace-existing` (or the
  configured catcher with `--replace-existing`)

No config change or restart is needed. Realm/environment mismatch is refused.

## Offboarding a client

Deleting the token file alone leaves the OAuth grant live on Intuit's side. Use
`npm run disconnect -- <slug>`, which revokes the grant first and then removes
the file.

## Wrong company's data appearing

Two connectors may point at the same `realmId`, or a token file may have been
copied. Run `list_companies.py`. Reauthorize a slug only when it should keep the
same realm; use the matching replacement flag above. If the slug should point
to a different company, authorize that company under a new slug first, verify
it, then explicitly offboard the incorrect slug. The connector will not retarget
an existing slug to another realm.

## Claude Desktop config got corrupted

`register_connector.py` refuses to write over invalid JSON and always backs up
first (`claude_desktop_config.json.bak-<timestamp>`). Restore the most recent
`.bak-*` file, fix the JSON, and re-run the script.
