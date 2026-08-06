// reconcile.js: pure matching logic for bank-statement reconciliation and
// duplicate-transaction detection. No I/O; fully unit-testable.

const DAY_MS = 86_400_000;
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Number(n.toFixed(2));
const sum = (rows) => round2(rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0));

// Turn an account-filtered General Ledger (already run through flattenReport +
// glFlatten) into a bank register.
//
// Why the GL and not a set of entity queries: every transaction that touches a
// bank account appears here by construction, including the transfers, bill
// payments, journal entries, directly-deposited payments, sales receipts and
// refunds that per-entity scans have to enumerate and inevitably under-cover.
// The report also carries the opening balance and a running balance, which is
// what makes a tie-out possible at all.
//
// Signs are QBO's natural signs for the account: on a bank account, positive is
// money in. That is also why the old Purchase-based scan mis-stated vendor
// refunds; here the direction comes from the ledger rather than from guessing
// at an entity's Credit flag.
//
// QBO leads with an opening-balance row carrying a running balance, no amount
// and a label ("Beginning Balance") in the date column. It is detected
// structurally, not by that label, which is localized.
export function bankRegisterFromGl(glRows) {
  let beginning_balance = null;
  const transactions = [];
  for (const r of glRows || []) {
    const dated = ISO_DATE.test(String(r.date ?? ""));
    if (!dated) {
      if (beginning_balance == null && r.amount == null && r.balance != null) beginning_balance = r.balance;
      continue;
    }
    if (r.amount == null) continue;
    transactions.push({
      id: r.id ?? null,
      type: r.type || null,
      date: r.date,
      num: r.num || null,
      name: r.name || null,
      memo: r.memo || null,
      split: r.split || null,
      amount: r.amount,
      balance: r.balance ?? null,
    });
  }
  const net = round2(transactions.reduce((s, t) => s + t.amount, 0));
  const last = transactions[transactions.length - 1];
  const ending_balance =
    last?.balance != null ? last.balance
    : beginning_balance != null ? round2(beginning_balance + net)
    : null;
  return { beginning_balance, transactions, ending_balance, net_activity: net };
}

// The classic two-column bank reconciliation, in the form a reviewer expects:
//
//   statement ending balance + deposits in transit - outstanding items
//     = adjusted bank balance
//   book (GL) ending balance + unrecorded receipts - unrecorded payments
//     = adjusted book balance
//
// The two adjusted figures should agree. `difference` is what is left over, and
// a non-zero value is the whole point of running this.
//
// statementEndingBalance is optional because a transaction CSV does not carry
// it. Without it the bridge cannot be computed and every balance field is null;
// the unmatched item lists are still produced.
export function bankTieOut({ statementEndingBalance, glEndingBalance, outflows, inflows }) {
  const deposits_in_transit = inflows?.register_only ?? [];
  const outstanding_items = outflows?.register_only ?? [];
  const unrecorded_receipts = inflows?.statement_only ?? [];
  const unrecorded_payments = outflows?.statement_only ?? [];

  const known = typeof statementEndingBalance === "number" && typeof glEndingBalance === "number";
  const adjusted_bank_balance = known
    ? round2(statementEndingBalance + sum(deposits_in_transit) - sum(outstanding_items))
    : null;
  const adjusted_book_balance = known
    ? round2(glEndingBalance + sum(unrecorded_receipts) - sum(unrecorded_payments))
    : null;
  const difference =
    adjusted_bank_balance != null && adjusted_book_balance != null
      ? round2(adjusted_bank_balance - adjusted_book_balance)
      : null;

  return {
    statement_ending_balance: known ? round2(statementEndingBalance) : null,
    book_ending_balance: typeof glEndingBalance === "number" ? round2(glEndingBalance) : null,
    deposits_in_transit: { count: deposits_in_transit.length, total: sum(deposits_in_transit) },
    outstanding_items: { count: outstanding_items.length, total: sum(outstanding_items) },
    unrecorded_receipts: { count: unrecorded_receipts.length, total: sum(unrecorded_receipts) },
    unrecorded_payments: { count: unrecorded_payments.length, total: sum(unrecorded_payments) },
    adjusted_bank_balance,
    adjusted_book_balance,
    difference,
    balanced: difference == null ? null : Math.abs(difference) < 0.005,
  };
}

// Match statement rows against register rows on amount (exact to the cent)
// and date (within toleranceDays), greedily preferring the closest date.
// Each register row is consumed at most once.
// Rows: { date: "YYYY-MM-DD", amount: number > 0, ... }
export function matchTransactions(statementRows, registerRows, { toleranceDays = 2 } = {}) {
  const used = new Set();
  const matched = [];
  const statement_only = [];
  for (const s of statementRows) {
    let best = null;
    let bestDiff = Infinity;
    for (let i = 0; i < registerRows.length; i++) {
      if (used.has(i)) continue;
      const q = registerRows[i];
      if (Math.abs((q.amount ?? 0) - (s.amount ?? 0)) > 0.005) continue;
      const diff = Math.abs(toMs(q.date) - toMs(s.date));
      if (diff <= toleranceDays * DAY_MS && diff < bestDiff) {
        best = i;
        bestDiff = diff;
      }
    }
    if (best != null) {
      used.add(best);
      matched.push({ statement: s, register: registerRows[best], date_diff_days: Math.round(bestDiff / DAY_MS) });
    } else {
      statement_only.push(s);
    }
  }
  const register_only = registerRows.filter((_, i) => !used.has(i));
  return { matched, statement_only, register_only };
}

// Group rows that share a party and exact amount, clustering by date within
// dateWindowDays. Returns only clusters of two or more (duplicate candidates).
// Rows: { id, party, amount, date: "YYYY-MM-DD", ... }
export function findDuplicateGroups(rows, { dateWindowDays = 3 } = {}) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.amount == null || !r.date) continue;
    const key = `${r.party ?? ""}|${Number(r.amount).toFixed(2)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const groups = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    let cluster = [sorted[0]];
    for (let i = 1; i <= sorted.length; i++) {
      const cur = sorted[i];
      const prev = cluster[cluster.length - 1];
      if (cur && toMs(cur.date) - toMs(prev.date) <= dateWindowDays * DAY_MS) {
        cluster.push(cur);
      } else {
        if (cluster.length > 1) groups.push(cluster);
        cluster = cur ? [cur] : [];
      }
    }
  }
  return groups;
}
