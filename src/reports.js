// reports.js: QBO report JSON flattening, multi-company consolidation, and a
// flat general-ledger export with simple review flags.
//
// QBO reports arrive as deeply nested Section/Row trees. flattenReport turns
// one into { columns, rows } where each row carries its section path; the
// consolidation and GL helpers build on that.

export function flattenReport(report) {
  const columns = (report?.Columns?.Column || []).map((c) => c.ColTitle || c.ColType || "");
  const rows = [];
  const walk = (container, path) => {
    for (const row of container?.Row || []) {
      const header = row.Header?.ColData?.[0]?.value;
      if (row.Rows || row.type === "Section") {
        walk(row.Rows, header ? [...path, header] : path);
        if (row.Summary?.ColData?.length) {
          rows.push({
            section: path.join(" > "),
            is_summary: true,
            values: row.Summary.ColData.map((c) => c.value ?? ""),
          });
        }
      } else if (row.ColData) {
        rows.push({
          section: path.join(" > "),
          is_summary: false,
          values: row.ColData.map((c) => c.value ?? ""),
        });
      }
    }
  };
  walk(report?.Rows, []);
  return { columns, rows };
}

export function toNumber(v) {
  const n = parseFloat(String(v ?? "").replace(/[,$%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Merge per-company flattened two-column reports (row name, amount) into one
// side-by-side table with a cross-company total. Row order follows the first
// company that produced each row.
export function consolidateReports(byCompany) {
  const keyOf = (r, name) => `${r.section}|${name}|${r.is_summary ? "S" : "R"}`;
  const order = [];
  const map = new Map();
  for (const { company, flat } of byCompany) {
    for (const r of flat.rows) {
      const name = r.values[0];
      if (!name) continue;
      const amount = toNumber(r.values[r.values.length - 1]);
      const k = keyOf(r, name);
      if (!map.has(k)) {
        map.set(k, { section: r.section, name, is_summary: r.is_summary, amounts: {} });
        order.push(k);
      }
      if (amount != null) map.get(k).amounts[company] = amount;
    }
  }
  const companies = byCompany.map((b) => b.company);
  const rows = order.map((k) => {
    const row = map.get(k);
    const total = companies.reduce((s, c) => s + (row.amounts[c] ?? 0), 0);
    return { ...row, total: Number(total.toFixed(2)) };
  });
  return { companies, rows };
}

// Map a flattened General Ledger report to plain transaction rows. Column
// positions are resolved from the report's own column titles, so the exact
// set/order requested does not matter.
export function glFlatten(flat) {
  const idx = {};
  flat.columns.forEach((c, i) => {
    const t = String(c).toLowerCase();
    if (t.includes("date")) idx.date ??= i;
    else if (t.includes("type")) idx.type ??= i;
    else if (t.includes("num")) idx.num ??= i;
    else if (t.includes("memo") || t.includes("description")) idx.memo ??= i;
    else if (t.includes("split")) idx.split ??= i;
    else if (t.includes("amount")) idx.amount ??= i;
    else if (t.includes("name")) idx.name ??= i;
  });
  const out = [];
  for (const r of flat.rows) {
    if (r.is_summary) continue;
    const get = (k) => (idx[k] != null ? r.values[idx[k]] : undefined);
    const amount = toNumber(get("amount"));
    const date = get("date");
    if (!date && amount == null) continue; // decorative rows ("Beginning Balance" etc. keep a date or amount)
    out.push({
      account: r.section,
      date,
      type: get("type"),
      num: get("num"),
      name: get("name"),
      memo: get("memo"),
      split: get("split"),
      amount,
    });
  }
  return out;
}

// Simple, documented review heuristics. Flags are hints for a human (or model)
// review pass, never conclusions.
export function flagGlRows(rows) {
  return rows.map((r) => {
    const flags = [];
    if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      const day = new Date(`${r.date}T00:00:00Z`).getUTCDay();
      if (day === 0 || day === 6) flags.push("weekend");
    }
    const a = Math.abs(r.amount ?? 0);
    if (a >= 1000 && Number.isInteger(a) && a % 100 === 0) flags.push("round_amount");
    if (a >= 10000) flags.push("large");
    if (String(r.type || "").toLowerCase().includes("journal")) flags.push("journal_entry");
    return flags.length ? { ...r, flags } : r;
  });
}
