// allocate.js: deciding how money lands against open documents.
//
// Pure and synchronous on purpose. The caller fetches the invoices, bills and
// vendor credits; this module decides what gets applied where, and refuses
// anything that would post a plausible-looking but wrong allocation.
//
// "Plausible-looking but wrong" is the whole reason this is separate and
// tested. A payment that lands 600 on the wrong invoice, or that silently
// leaves 40 unapplied, reads as a perfectly normal success in the API
// response. Every rule below exists to turn one of those into a refusal.

const CENT = 0.005;
const round2 = (n) => Number(n.toFixed(2));
const money = (n) => round2(Number(n) || 0);

// Report every problem at once. Fixing an allocation one rejection at a time
// is miserable, and each round trip is another chance to post something wrong.
function raise(errors) {
  if (errors.length === 1) throw new Error(errors[0]);
  throw new Error(`This allocation was refused for ${errors.length} reasons:\n- ${errors.join("\n- ")}`);
}

// Apply a customer payment across specific invoices.
//
// allocations: [{ invoice_id, amount }]
// invoices:    the fetched Invoice records, in any order
// total:       the payment total, which must equal the sum of the allocations
// customerId:  every invoice must belong to this customer
export function planInvoiceAllocations({ allocations, invoices, total, customerId }) {
  const errors = [];
  const byId = new Map((invoices || []).map((i) => [String(i.Id), i]));
  const seen = new Set();
  const plan = [];

  for (const a of allocations || []) {
    const id = String(a?.invoice_id ?? "");
    const applying = money(a?.amount);
    const inv = byId.get(id);

    if (!inv) { errors.push(`No invoice with Id ${id || "(blank)"}.`); continue; }
    if (seen.has(id)) { errors.push(`Invoice ${id} is listed twice; combine the two amounts into one allocation.`); continue; }
    seen.add(id);

    // A payment applied to another customer's invoice is the single most
    // damaging mistake available here, and QBO will not stop you.
    const owner = String(inv.CustomerRef?.value ?? "");
    if (customerId && owner && owner !== String(customerId)) {
      errors.push(
        `Invoice ${id} (${inv.DocNumber || "no number"}) belongs to ${inv.CustomerRef?.name || `customer ${owner}`}, not the customer being paid.`
      );
      continue;
    }

    const open = money(inv.Balance);
    if (applying <= 0) { errors.push(`Allocation to invoice ${id} must be greater than zero, got ${applying}.`); continue; }
    if (applying - open > CENT) {
      errors.push(`Allocation of ${applying.toFixed(2)} to invoice ${id} (${inv.DocNumber || "no number"}) exceeds its open balance of ${open.toFixed(2)}.`);
      continue;
    }

    plan.push({
      invoice_id: id,
      doc_number: inv.DocNumber ?? null,
      open_balance: open,
      applying,
      balance_after: round2(open - applying),
      closes_invoice: Math.abs(open - applying) < CENT,
    });
  }

  if (!plan.length && !errors.length) errors.push("No allocations were given.");

  const allocated = round2(plan.reduce((s, p) => s + p.applying, 0));
  const paymentTotal = money(total);
  if (!errors.length && Math.abs(allocated - paymentTotal) > CENT) {
    const diff = round2(paymentTotal - allocated);
    errors.push(
      diff > 0
        ? `The allocations total ${allocated.toFixed(2)} but the payment is ${paymentTotal.toFixed(2)}, leaving ${diff.toFixed(2)} unapplied. Allocate the difference or lower the payment amount.`
        : `The allocations total ${allocated.toFixed(2)}, which is ${Math.abs(diff).toFixed(2)} more than the payment of ${paymentTotal.toFixed(2)}.`
    );
  }
  if (errors.length) raise(errors);

  return {
    plan,
    total_allocated: allocated,
    invoices_closed: plan.filter((p) => p.closes_invoice).length,
    lines: plan.map((p) => ({
      Amount: p.applying,
      LinkedTxn: [{ TxnId: p.invoice_id, TxnType: "Invoice" }],
    })),
  };
}

// Settle bills with a mix of cash and vendor credits.
//
// Verified against a sandbox company on 2026-08-05: a BillPayment whose lines
// link a Bill and a VendorCredit clears both, with TotalAmt carrying only the
// cash. QBO stores the credit line as a positive amount regardless of the sign
// sent, so positives are sent here.
//
// Credits are applied in full, in the order given, and then cash plus credits
// is spread across the bills in the order given, capped at each open balance.
// Underpaying is allowed (a partial payment); overpaying is refused.
export function planBillPaymentApplication({ bills, credits, amount }) {
  const errors = [];
  const cash = money(amount);

  const creditPlan = [];
  for (const cr of credits || []) {
    const open = money(cr.Balance);
    if (open <= 0) {
      errors.push(`Vendor credit ${cr.Id} has no open balance left to apply.`);
      continue;
    }
    creditPlan.push({ vendor_credit_id: String(cr.Id), applying: open });
  }
  const creditsTotal = round2(creditPlan.reduce((s, c) => s + c.applying, 0));

  let remaining = round2(cash + creditsTotal);
  const billPlan = [];
  for (const b of bills || []) {
    const open = money(b.Balance);
    const applying = round2(Math.min(remaining, open));
    if (applying <= 0) continue;
    billPlan.push({
      bill_id: String(b.Id),
      doc_number: b.DocNumber ?? null,
      open_balance: open,
      applying,
      balance_after: round2(open - applying),
      closes_bill: Math.abs(open - applying) < CENT,
    });
    remaining = round2(remaining - applying);
  }

  if (remaining > CENT) {
    errors.push(
      creditsTotal > 0
        ? `Cash of ${cash.toFixed(2)} plus credits of ${creditsTotal.toFixed(2)} exceeds the listed bills' open balances by ${remaining.toFixed(2)}. Lower the amount, drop a credit, or add more bills.`
        : `Payment of ${cash.toFixed(2)} exceeds the open balance of the listed bills by ${remaining.toFixed(2)}. Lower the amount or add more bills.`
    );
  }
  if (errors.length) raise(errors);

  return {
    bills: billPlan,
    credits: creditPlan,
    cash_paid: cash,
    credits_applied: creditsTotal,
    total_settled: round2(cash + creditsTotal),
    lines: [
      ...billPlan.map((b) => ({ Amount: b.applying, LinkedTxn: [{ TxnId: b.bill_id, TxnType: "Bill" }] })),
      ...creditPlan.map((c) => ({ Amount: c.applying, LinkedTxn: [{ TxnId: c.vendor_credit_id, TxnType: "VendorCredit" }] })),
    ],
  };
}
