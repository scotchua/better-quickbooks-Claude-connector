// links.js: reading QuickBooks' LinkedTxn graph.
//
// QBO records a relationship on both ends, but not in the same place. A
// Payment carries its links on each Line, together with the amount applied to
// that document; the Invoice on the other side carries a bare LinkedTxn with
// no amount. Verified against a sandbox company on 2026-08-05: a VendorCredit
// consumed by a BillPayment gains a LinkedTxn pointing back at the payment.
//
// So traversal works from either side, but only the "money" side knows how
// much was applied. Both are collected here and the amount is reported when it
// exists rather than inferred when it does not.

// TxnTypes that name a queryable entity, so a summary can be fetched. Types
// outside this set (ReimburseCharge, StatementCharge and friends) are real
// links but are not addressable through the query endpoint; they are returned
// without a summary rather than dropped or errored on.
export const READABLE_TXN_TYPES = new Set([
  "Invoice", "Bill", "BillPayment", "Payment", "CreditMemo", "VendorCredit",
  "Deposit", "Estimate", "SalesReceipt", "PurchaseOrder", "JournalEntry",
  "Purchase", "RefundReceipt", "TimeActivity", "Transfer",
]);

// Every link a transaction declares: the top-level LinkedTxn array plus each
// line's own. Deduped by type and id, keeping whichever copy knows the amount.
export function extractLinks(entity) {
  const byKey = new Map();
  const add = (l, amount, line) => {
    const type = l?.TxnType;
    const id = l?.TxnId == null ? null : String(l.TxnId);
    if (!type || !id) return;
    const key = `${type}|${id}`;
    const existing = byKey.get(key);
    const next = {
      txn_type: type,
      txn_id: id,
      ...(amount != null ? { amount_applied: Number(amount) } : {}),
      ...(line != null ? { on_line: line } : {}),
    };
    // A link named both at the top level and on a line is one relationship.
    // Prefer the copy carrying the applied amount.
    if (!existing || (existing.amount_applied == null && next.amount_applied != null)) {
      byKey.set(key, next);
    }
  };

  for (const l of entity?.LinkedTxn || []) add(l);
  (entity?.Line || []).forEach((line, i) => {
    for (const l of line?.LinkedTxn || []) add(l, line?.Amount ?? null, i + 1);
  });
  return [...byKey.values()];
}

// One uniform shape for any linked document, so a chain of mixed types reads
// as a table instead of a pile of differently-shaped entities.
export function summarizeTxn(entity) {
  if (!entity) return null;
  return {
    id: entity.Id ?? null,
    date: entity.TxnDate ?? null,
    doc_number: entity.DocNumber ?? null,
    total: entity.TotalAmt ?? null,
    balance: entity.Balance ?? null,
    party:
      entity.CustomerRef?.name ?? entity.VendorRef?.name ?? entity.EntityRef?.name
      ?? entity.CustomerRef?.value ?? entity.VendorRef?.value ?? null,
    memo: entity.PrivateNote ?? null,
  };
}

// A plain-language reading of the chain, so the answer does not depend on the
// caller knowing which direction QBO happened to record.
export function describeChain(txnType, summary, links) {
  if (!links.length) {
    return `${txnType} ${summary?.id ?? ""} is not linked to any other transaction.`.replace(/\s+/g, " ").trim();
  }
  const applied = links.filter((l) => l.amount_applied != null);
  const total = applied.reduce((s, l) => s + l.amount_applied, 0);
  const byType = links.reduce((m, l) => m.set(l.txn_type, (m.get(l.txn_type) || 0) + 1), new Map());
  const parts = [...byType.entries()].map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`);
  const head = `${txnType} ${summary?.id ?? ""} is linked to ${parts.join(", ")}.`.replace(/\s+/g, " ");
  return applied.length
    ? `${head} ${applied.length === links.length ? "It applies" : "Of those, the amounts it applies total"} ${total.toFixed(2)}.`
    : `${head} The applied amounts are recorded on the other side of each link.`;
}
