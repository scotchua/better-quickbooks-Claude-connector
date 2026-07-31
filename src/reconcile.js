// reconcile.js: pure matching logic for bank-statement reconciliation and
// duplicate-transaction detection. No I/O; fully unit-testable.

const DAY_MS = 86_400_000;
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);

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
