# Firm-hosted OAuth catcher

`index.html` is a self-contained replacement for the Lovable-hosted catcher
page (`https://qbo-oauth-catcher.lovable.app`). It reads the `code`, `state`,
and `realmId` off its own URL and shows a copy button. No external requests,
no analytics, nothing stored or transmitted; the pasted line is useless
without the app's client secret, and the code is single-use.

Why move it: the catcher sits in the production OAuth path for every client
authorization. Hosting it on infrastructure the firm controls removes a
third party from that path. This is trust-surface reduction, not an active
vulnerability fix.

## Deploy (pick one, ~10 minutes)

- GitHub Pages: push this folder to a repo the firm owns, enable Pages, note
  the URL (e.g. `https://<org>.github.io/qbo-oauth-catcher/`).
- A 1953.tax subdomain: upload `index.html` to any static host and point
  `qbo-oauth.1953.tax` at it. HTTPS is required by Intuit.

## Switch over (after deploying)

1. Add the new URL as a Redirect URI in the Intuit app (Development and
   Production), alongside the old one.
2. Set `QBO_CATCHER_REDIRECT_URI=<new url>` in `qbo-mcp-server/.env`.
3. Run one test authorization (`npm run connect:catcher -- <slug>`).
4. Remove the lovable.app redirect URI from the Intuit app.

Until step 4, both catchers work; `connect-catcher.js` uses whichever
`QBO_CATCHER_REDIRECT_URI` names, defaulting to the Lovable page.
