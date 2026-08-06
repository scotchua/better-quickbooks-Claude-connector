# Testing checklist

How to prove this connector works before it touches a client's real books. Work
top to bottom. Stage 1 needs no QuickBooks account at all; Stage 2 uses Intuit's
free sandbox (fake books, zero risk); Stage 3 is a controlled production pilot.

Times are for a first run. Re-running Stage 1 takes seconds.

- Stage 1, automated checks: 3 minutes
- Stage 2, sandbox walkthrough: 45 to 60 minutes
- Stage 3, production pilot: 30 minutes plus your own judgment

---

## Stage 1: Automated checks (no QuickBooks needed)

```bash
npm install
npm test
```

**Pass:** `Tests 156 passed (156)`. This covers the security-critical logic:
query escaping, CSV sign and date handling, the import journal's crash-window
resume, write-policy enforcement including its fail-closed behaviour on an
unreadable or malformed policy file, destructive-path detection for the raw
api_request escape hatch, the QBO_FILES_DIR fence including symlink escape,
cross-process token-refresh locking, token encryption round-trip and
tamper rejection, audit records, report consolidation, statement matching,
duplicate clustering, policy enforcement, and filter allowlists.

The suite also includes `test/server-contract.test.js`, which starts the real
server, speaks MCP over stdio, and asserts what a client actually receives: the
full 114-tool surface, a description and input schema on every tool, correct
read-only/destructive annotations, the reported version matching package.json,
and both kill switches removing exactly the right tools. That is the only test
exercising registration itself, so it is the one that catches a broken import or
a mis-derived annotation before Claude Desktop does.

You can still confirm startup by hand:

```bash
node src/index.js < /dev/null            # ctrl-C after the startup line
QBO_DISABLE_WRITES=true node src/index.js < /dev/null
QBO_DISABLE_DELETES=true node src/index.js < /dev/null
```

**Pass:** the first prints `QBO MCP server running (stdio).`; the second reports
52 write tools suppressed; the third reports 4.

---

## Stage 2: Sandbox walkthrough (fake books)

### Setup

1. Sandbox keys from [developer.intuit.com](https://developer.intuit.com) in
   `.env`, with `QBO_ENVIRONMENT=sandbox`.
2. Create a second sandbox company in the developer portal (you need two to test
   the fleet tools).
3. Authorize both:
   ```bash
   QBO_COMPANY=test1 npm run connect
   QBO_COMPANY=test2 npm run connect
   ```
4. Register the connector once: `/add-qbo-company` in Claude Code, or
   `python3 .claude/skills/add-qbo-company/scripts/register_connector.py --project-dir . --node "$(which node)"`.
5. Fully quit and reopen Claude Desktop (Cmd-Q on Mac; tray icon then Quit on
   Windows). This is the only restart you should ever need.

### Foundation

- [ ] **Health.** Ask: *"Run health_check on all companies."*
      Pass: both companies report `status: ok`, a company name, and token
      countdowns.
- [ ] **Encryption at rest.** Open `tokens.test1.json` in a text editor.
      Pass: you see an `enc` block plus realmId and environment, and **no**
      readable tokens. A `.qbo-key` file or a `qbo-mcp-server` Keychain entry
      now exists.
- [ ] **No-restart claim.** Authorize a third sandbox
      (`QBO_COMPANY=test3 npm run connect`), then ask *"list my QuickBooks
      companies"* without restarting anything.
      Pass: it appears immediately.
- [ ] **Company gate.** Ask for a write without naming a company, e.g.
      *"create a $10 invoice"* (with no company selected).
      Pass: it refuses and lists the connected companies rather than guessing.

### Reads and search

- [ ] **Reports.** *"Show me this year's P&L and balance sheet for test1."*
- [ ] **New reads.** *"Show customer balances, vendor balances, and sales by
      customer for test1."*
- [ ] **Compact output.** *"List test1 invoices."*
      Pass: tidy rows (Id, DocNumber, dates, customer, total, balance), not
      hundreds of lines of raw QuickBooks JSON. Add *"with verbose output"* to
      see the full entities.
- [ ] **Typed filters.** *"List test1 invoices with a balance over 100, sorted
      by date descending."* Then try something illegal:
      *"Filter invoices where SecretField equals x."*
      Pass: the first works; the second refuses and lists the filterable fields.
- [ ] **Truncation honesty.** On a company with many rows, check any list
      response for `truncated: false` (or `true` with a count).
      Pass: the flag is present, so a partial answer can never look complete.

### Writes and guardrails

- [ ] **Tolerant lookups.** *"Create a bill for vendor Bobs Burger Joint for
      $50 to Meals"* (a vendor that does not exist).
      Pass: it refuses and suggests close existing names instead of silently
      creating a phantom vendor. Retry adding *"create the vendor if missing"*
      and it proceeds.
- [ ] **AP cycle.** Create a bill, then *"pay that bill by check from
      checking,"* then *"list bill payments for test1."*
      Pass: the payment links to the bill and shows in the list.
- [ ] **Transfer.** *"Transfer $100 from checking to savings in test1."*
- [ ] **Journal entry.** *"Post a journal entry to test1: debit Miscellaneous
      50, credit Checking 50."* Then try an unbalanced one (debit 50, credit
      40).
      Pass: the second is refused before anything is sent to QuickBooks.
- [ ] **Setup entities.** *"Create a class called Ketchikan and a location
      called Longview in test1."* Then post an expense tagged to that class.
- [ ] **PDF.** *"Download the PDF for invoice <id> in test1."*
      Pass: a real PDF lands in `exports/` and opens.
- [ ] **Closed period.** In the sandbox QuickBooks UI set a closing date (gear
      icon, Account and settings, Advanced, Close the books). Post a journal
      entry dated before it.
      Pass: the response includes a `warnings` field naming the close date.
      Now set `QBO_CLOSED_PERIOD=block` in `.env`, restart Desktop, retry.
      Pass: refused outright.

### Bank CSV

Save this as `test-bank.csv`:

```csv
Date,Description,Amount
07/05/2026,COFFEE SHOP PURCHASE,-18.50
07/08/2026,OFFICE SUPPLY STORE,-142.11
07/12/2026,CLIENT PAYMENT DEPOSIT,2500.00
07/15/2026,SOFTWARE SUBSCRIPTION,-89.00
```

- [ ] **Dry run.** *"Dry-run import test-bank.csv into test1 against checking."*
      Pass: 3 outflow rows planned, the 2,500 deposit reported as a skipped
      inflow (**not** an expense), dates normalized to ISO, an `import_id`
      shown.
- [ ] **Live import,** then **run the exact same import again.**
      Pass: the second run reports `imported: 0` with
      `rows_already_posted: 3`. No duplicates in QuickBooks.
- [ ] **Reconcile.** *"Reconcile test-bank.csv against checking in test1."*
      Pass: the 3 imported rows match; the deposit shows as on-statement,
      not-in-books.
- [ ] **Duplicates.** Create the same expense twice (same vendor, amount, date),
      then *"scan test1 for duplicate purchases this month."*
      Pass: one candidate group containing both.
- [ ] **Gated delete.** Delete one of those duplicates with
      *"delete purchase <id> from test1."*
      Pass: it is removed, and the response echoes what was deleted.

### Multi-company

- [ ] **Consolidated P&L.** *"Run a consolidated P&L across test1 and test2 for
      this year."*
      Pass: one table, a column per company, a combined total column.
- [ ] **Consolidated balance sheet.** Same across both companies.
- [ ] **Multi-company journal entry.** *"Post this journal entry to both test1
      and test2: debit Miscellaneous 25, credit Checking 25."*
      Pass: per-company results, each with its own journal entry Id.
- [ ] **Change tracking.** *"What changed in test1 since yesterday?"*
      Pass: everything you just created is listed.

### Governance

- [ ] **Audit trail.** `cat audit-log/audit-2026-07.jsonl`
      Pass: one line per write you made, each with company, realm, entity,
      amount, and an `intuit_tid`.
- [ ] **Policy: read-only client.** Copy `qbo-policy.example.json` to
      `qbo-policy.json` with `{"companies": {"test1": {"read_only": true}}}`.
      Try any write to test1 (no restart needed).
      Pass: refused with a policy message naming the file. Reads still work.
- [ ] **Policy: amount ceiling.** Change it to
      `{"defaults": {"max_write_amount": 100}}` and try a $250 invoice.
      Pass: refused. Delete `qbo-policy.json` when done.
- [ ] **Read-only deployment.** Set `QBO_DISABLE_WRITES=true` in `.env`, restart
      Claude Desktop, and open Settings, Connectors, qbo.
      Pass: the write tools are **gone from the list**, not merely blocked.
      Remove the setting and restart to get them back.
- [ ] **Offboarding.** `npm run disconnect -- test3`
      Pass: it reports the revocation and the token file is gone.

---

## Stage 3: Production pilot

Do this on the firm's own books first, never a client's.

1. **Connect one production company** with production keys
   (`QBO_ENVIRONMENT=production`). Note: if Intuit rejects the localhost
   redirect for production, that is an Intuit app-setup constraint, not a bug
   here; check the app's Redirect URIs in the developer portal.
2. **Start read-only.** Put the company in `qbo-policy.json` with
   `read_only: true` before doing anything else. Then exercise reports,
   searches, `reconcile_bank_csv`, and `get_general_ledger_flat` freely with
   zero write risk while you judge the quality of what comes back.
3. **First write, reversible.** Lift read-only, create a small invoice to a test
   customer, then void it. Verify both in the QuickBooks UI and in
   `audit-log/`.
4. **Set tool permissions** in Claude Desktop, Settings, Connectors, qbo:
   - Reads, searches, `health_check`, `api_get`: **Always allow**
   - Every create/update/send/void/delete, `import_transactions_from_csv`, and
     `api_request`: **Needs approval**
5. **Then onboard clients**, one at a time, each starting read-only.

---

## Known limitations to test around

- **Reconciliation is a worksheet, not a QuickBooks reconciliation.** The
  register is built from the account's General Ledger, so every transaction
  type that touches the account is covered (transfers, bill payments, journal
  entries, directly-deposited payments, sales receipts, refunds). What it
  cannot do is mark anything cleared: the Accounting API neither exposes nor
  sets reconciliation status, so the QuickBooks Reconcile screen still has to
  be worked by hand, and an edit to a previously reconciled transaction is
  invisible here. Pass `statement_ending_balance` to get the tie-out; without
  it you get the unmatched lists only.
- **Change data capture** covers roughly the last 30 days only.
- **Duplicate detection** flags candidates, not conclusions. Legitimate repeats
  (rent, subscriptions) look identical to duplicates.
- **Inventory quantity adjustments** are not exposed *by this connector*. They
  are available in Intuit's Accounting API through the `InventoryAdjustment`
  entity, which is queryable today under the standard accounting scope; the
  connector simply does not wrap it yet. Reach it with `api_get` or `query` for
  reads. (An earlier version of this file said the API did not support them at
  all. That was wrong.)
- **Payroll runs** genuinely are not exposed by Intuit's accounting API; those
  stay in the QuickBooks UI and your payroll system.
- **`delete_transaction` is permanent.** Prefer `void_invoice` for invoices so
  the number trail survives.

## If something fails

Collect these three things and the cause is usually obvious:

1. The exact error text (it includes `intuit_tid`, which is what Intuit support
   needs).
2. The matching line from `audit-log/audit-YYYY-MM.jsonl`.
3. The `health_check` output for that company.

Rollback levers, all in `.env`: `QBO_TOKEN_ENCRYPTION=off` (revert to plaintext
token files), `QBO_CLOSED_PERIOD=off`, `QBO_AUDIT=off`, and
`QBO_DISABLE_WRITES=true` (lock the whole thing down to reads).
