# Firm-hosted OAuth catcher

## In plain language

When you give this tool permission to read a QuickBooks company, Intuit hands
back a permission slip. For real client files, Intuit refuses to deliver that
slip to your own computer, so it has to land on a page out on the web.

Earlier versions came pre-set to a page the maintainer hosted. That worked, but
it had two problems: every firm using the tool depended on someone else's
website staying up, and that web address travelled inside the shared code.

The tool now ships with no page set at all. You pick one of two routes:

- **Use Intuit's own page.** Nothing to host, nothing to maintain, and every
  step stays on Intuit's site. This is the recommended route and takes about two
  minutes per company: `npm run connect:playground -- <slug>`.
- **Host your own copy.** The page is in this folder. Put it on any web address
  you control and point the tool at it, which is what the rest of this file
  covers.

Security is the same either way. What you paste back is single use, expires
within minutes, and is worthless to anyone without your own secret key.

## The page

`index.html` is a self-contained catcher page for you to host. It reads the `code`, `state`,
and `realmId` off its own URL and shows a copy button. No external requests,
no analytics, nothing stored or transmitted; the pasted line is useless
without the app's client secret, and the code is single-use.

Why host your own: the catcher sits in the production OAuth path for every
client authorization. Running it on infrastructure you control keeps a third
party out of that path. The connector ships no default page, so this flow does
nothing until QBO_CATCHER_REDIRECT_URI names a page you own.

You may not need this at all: `npm run connect:playground -- <slug>` imports
tokens minted in Intuit's own OAuth 2.0 Playground, so every hop stays on
Intuit-operated pages and there is nothing to deploy. That is the recommended
production path; this page is the alternative for anyone who prefers a
one-paste redirect flow.

## Deploy (pick one, ~10 minutes)

- GitHub Pages: push this folder to a repo you own, enable Pages, and note the
  URL (e.g. `https://<your-org>.github.io/qbo-oauth-catcher/`).
- Your own domain: upload `index.html` to any static host and point a
  subdomain at it. HTTPS is required by Intuit; the page needs no backend.

## Switch over (after deploying)

1. Add the URL as a Redirect URI in the Intuit app (Development and
   Production).
2. Set `QBO_CATCHER_REDIRECT_URI=<your url>` in `qbo-mcp-server/.env`.
3. Run one test authorization: `npm run connect:catcher -- <slug>`.
   Add `--no-browser` to print the authorize URL instead of launching one.
   If Intuit says the redirect_uri is invalid, the URL is not registered on the
   app yet; the flow prints the exact URL it is redirecting to so you can compare.

`connect-catcher.js` uses exactly what that variable names and refuses to run
without it, so there is no fallback page to retire later.
