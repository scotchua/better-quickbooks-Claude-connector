# Setup Guide: Connect QuickBooks to Claude (the easy way)

This is the friendly, no-jargon walkthrough for connecting your QuickBooks Online
companies to Claude Desktop. You let **Claude Code do the work**: you paste a
couple of keys, log into each company once, and click **Allow**.

Plan for about **20 minutes** for your first setup. Adding more companies later
takes a couple of minutes each, with no restart.

> **What you'll end up with:** one **`qbo`** connector in Claude Desktop that can
> reach **all** of your companies. You pick the company as you work: *"work on
> acme"*, or name it in any request. No switching connectors, no restarts.

---

## Before you start

You need:

- A **Mac or Windows PC**
- [Claude Desktop](https://claude.ai/download) installed
- [Claude Code](https://claude.ai/download) (this is what runs the setup for you)
- The **QuickBooks Online login** for each company you want to connect
- An **Intuit Developer** account (free; you'll make one in Step 4)

---

## Step 1: Download this project

On the project's GitHub page, click the green **`< > Code`** button, then
**Download ZIP**.

Unzip it (Mac: double-click; Windows: right-click, then **Extract All**) and put
the folder on your **Desktop**.

## Step 2: Open the folder in Claude Code

Open **Claude Code** and point it at the folder you just unzipped (give it access
to that folder). This is the window where you talk to Claude and it does the
technical steps for you.

## Step 3: Tell Claude what you want

Type this into Claude Code, using the number of clients you're setting up:

> **Help me install this for 4 clients.**

Claude takes it from here. It installs everything the app needs and walks you
through the rest. The steps below are what Claude will guide you through, so you
know what's coming.

## Step 4: Get your QuickBooks keys (one time, ever)

The app needs two secret keys from Intuit so it can talk to QuickBooks.

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in.
2. Create a new app and choose the **Accounting** scope.
3. Open the **Keys & OAuth** page and copy the **Client ID** and **Client Secret**.
4. On that same page, add this exact **Redirect URI**:
   `http://localhost:3000/callback`
   *(If this is missing, the login in Step 6 will fail.)*

> **Sandbox vs. production:** Intuit gives you separate keys for **sandbox** (test
> companies) and **production** (real client books). Use the set that matches what
> you're connecting. If in doubt and it's a real business, it's production.

## Step 5: Create the `.env` file (paste your keys)

Claude creates a settings file called **`.env`** and opens it for you. Paste your
**Client ID** and **Client Secret** into the matching lines, then **save**.

Claude confirms the keys are in place **without printing your secret** on screen.

## Step 6: Connect your companies (log in once, click Allow)

Claude starts the connection flow and gives you a link (your browser usually opens
on its own).

1. **Log into Intuit once**; it remembers you for the rest.
2. **Pick the first company** and click **Allow**.
3. The browser **reopens automatically** for the next company. Pick it, click
   **Allow**, and repeat until all your companies are done.

That's the only hands-on part. Your login passes are saved **encrypted** on your
own computer, one file per company.

## Step 7: Register the connector (once, ever)

Claude adds a single **`qbo`** connector to Claude Desktop and verifies it. This
happens once; every company you connect, now or later, shows up through it.

## Step 8: Restart Claude Desktop (first time only)

- **Mac:** press **Cmd + Q** to quit, then reopen.
- **Windows:** right-click the Claude icon in the **system tray** (bottom-right by
  the clock), choose **Quit**, then reopen.

After this first restart, adding more companies needs **no restart at all**: the
connector sees new companies the moment they're authorized.

## Step 9: Set tool permissions (recommended)

Open **Claude Desktop → Settings → Connectors**, click the **qbo** connector, and
you'll see its **Tool permissions**.

- **Read-only tools → Always allow.** They only look at the books: reports,
  lists, searches, `health_check`, `api_get`.
- **Write tools → Needs approval.** They change the books, so keep a human in the
  loop: *Create invoice, Create bill, Create bill payment, Create journal entry,
  Void invoice, Import transactions from CSV*, and **`api_request`** (it can post
  anything, so never set it to Always allow).

> **Extra safety already built in:** the app refuses to guess which company a
> write targets, warns when a write lands in a closed period, keeps a local log
> of every change it posts, and can enforce per-company rules (like read-only
> clients) from a `qbo-policy.json` file.

## Step 10: Try it

Ask Claude Desktop something like:

- *"List my QuickBooks companies."*
- *"Work on acme. Show me this year's profit and loss."*
- *"Run a consolidated P&L across all my companies for last quarter."*
- *"Who owes bakery money? Pull the aged receivables."*

If you get numbers back, you're done.

---

## Configuring Claude Desktop

Only needed if you are wiring the connector up by hand instead of letting
`/add-qbo-company` do it, or if Claude Desktop shows the connector as
disconnected.

The config file lives at:

- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Start from `claude_desktop_config.snippet.json` in this folder, and replace
**both** values. They are placeholders, specific to each machine, and using them
unchanged fails with "server disconnected":

| Field | How to find it | Why it differs per machine |
|---|---|---|
| `command` | `which node` (Mac) or `where node` (Windows) | nvm, Homebrew, Volta, and system Node all install elsewhere |
| `args[0]` | run `pwd` in this folder, then add `/src/index.js` | depends where you unzipped it |

Four things that trip people up:

- Both paths must be **absolute**. A bare `"node"` fails, because Claude Desktop
  starts the server without your shell's `PATH`.
- On Windows, double every backslash in JSON:
  `C:\\Users\\you\\qbo-mcp-server\\src\\index.js`.
- If your download produced a folder like `...-main-2`, or you renamed it, the
  path has to match the folder that actually exists on disk.
- Restart Claude Desktop completely afterward (Mac: `Cmd + Q`; Windows: quit from
  the system tray, not just the window).

**Setting this up with Claude?** Tell it to run `which node` and `pwd` in this
folder and use those actual results. An assistant that reuses the placeholder
paths, or a path it saw in these docs, produces a config that cannot start.

## Adding more clients later

Open Claude Code in the same folder and say:

> **Add another QuickBooks company.**

Log in, click Allow, and it's live immediately. No restart.

## Removing a client

Say **"disconnect acme"** in Claude Code, or run `npm run disconnect -- acme`.
This revokes the app's access with Intuit and deletes the stored login pass,
which is the complete offboarding step.

## If something goes wrong

The simplest fix for almost anything: **tell Claude Code what happened.** It can
re-check the connection, re-authorize a company, or run `health_check` to test
every company in one call.

- **The connector didn't appear?** You probably just need the one-time full
  restart of Claude Desktop (Step 8).
- **The login didn't work?** Ask Claude to start the connection again.
- **Anything else?** Describe what you saw to Claude and it will take it from
  there.
