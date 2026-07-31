// lines.js: shared line-item schemas and builders for transaction tools.
//
// Every line schema accepts an optional `class` (QBO class tracking). Journal
// lines also accept a per-line `location` (department). Sales lines accept a
// `tax_code` ("TAX"/"NON" under US automated sales tax, or a TaxCode name/Id).
// References are resolved by name or Id with tolerant matching (entities.js).

import { z } from "zod";
import { qboQuery } from "./qbo.js";
import { esc, assertBalanced } from "./util.js";
import { resolveRef, findByName, findAnyServiceItem, notFoundError, suggestNames } from "./entities.js";

// ---- schemas ----------------------------------------------------------------

const classArg = z.string().optional().describe("Class name or Id (requires class tracking)");

export const journalLineSchema = z.object({
  account: z.string().describe("Account name or Id to post this line to"),
  amount: z.number().positive().describe("Positive amount; direction is set by posting_type"),
  posting_type: z.enum(["Debit", "Credit"]),
  description: z.string().optional().describe("Per-line memo"),
  entity_name: z.string().optional().describe("Optional customer/vendor/employee to tag this line to"),
  entity_type: z.enum(["Customer", "Vendor", "Employee"]).optional().describe("Required if entity_name is set"),
  class: classArg,
  location: z.string().optional().describe("Location/department name or Id"),
});

export const salesLineSchema = z.object({
  amount: z.number().describe("Line amount"),
  item: z.string().optional().describe("Product/Service name or Id (defaults to any Service item)"),
  description: z.string().optional(),
  quantity: z.number().optional(),
  unit_price: z.number().optional(),
  class: classArg,
  tax_code: z.string().optional().describe("TAX or NON (US automated sales tax), or a TaxCode name/Id"),
});

export const accountLineSchema = z.object({
  account: z.string().describe("Account name or Id to categorize against"),
  amount: z.number(),
  description: z.string().optional(),
  class: classArg,
});

export const itemLineSchema = z.object({
  item: z.string().describe("Product/Service name or Id"),
  amount: z.number(),
  quantity: z.number().optional(),
  unit_price: z.number().optional(),
  description: z.string().optional(),
  class: classArg,
});

export const depositLineSchema = z.object({
  account: z.string().describe("Source account name or Id (e.g. an income account or Undeposited Funds)"),
  amount: z.number(),
  description: z.string().optional(),
  entity_name: z.string().optional(),
  entity_type: z.enum(["Customer", "Vendor", "Employee"]).optional(),
  class: classArg,
});

// ---- shared resolution helpers ----------------------------------------------

async function classRef(name, company) {
  return resolveRef("Class", name, company, "Name");
}

export async function departmentRef(name, company) {
  return resolveRef("Department", name, company, "Name");
}

// "TAX"/"NON" are literal pseudo-ids under US automated sales tax; anything
// else resolves as a TaxCode by Id or Name.
async function taxCodeRef(v, company) {
  const upper = String(v).trim().toUpperCase();
  if (upper === "TAX" || upper === "NON") return { value: upper };
  if (/^\d+$/.test(String(v).trim())) return { value: String(v).trim() };
  const rec = (await qboQuery(`SELECT * FROM TaxCode WHERE Name = '${esc(v)}'`, { company })).TaxCode?.[0];
  if (!rec) throw new Error(`TaxCode not found: "${v}". Use TAX, NON, or an existing tax code name.`);
  return { value: rec.Id, name: rec.Name };
}

// ---- builders ----------------------------------------------------------------

// Resolve a name/vendor/employee referenced on a journal line to its Id.
async function resolveEntityId(name, type, company) {
  const rec = await findByName(type, name, company);
  if (!rec) throw notFoundError(type, name, await suggestNames(type, name, company));
  return rec.Id;
}

// Turn the ergonomic line schema into QBO JournalEntryLineDetail lines,
// resolving account (and any entity/class/location) references and asserting
// the entry balances.
export async function buildJournalLines(lines, company) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error("A journal entry needs at least two lines, with total debits equal to total credits.");
  }
  assertBalanced(lines);
  const out = [];
  for (const li of lines) {
    const acct = await resolveRef("Account", li.account, company, "Name");
    const detail = {
      PostingType: li.posting_type,
      AccountRef: acct,
    };
    if (li.entity_name) {
      if (!li.entity_type) throw new Error(`entity_type is required when entity_name is set (line account "${li.account}").`);
      detail.Entity = { Type: li.entity_type, EntityRef: { value: await resolveEntityId(li.entity_name, li.entity_type, company) } };
    }
    if (li.class) detail.ClassRef = await classRef(li.class, company);
    if (li.location) detail.DepartmentRef = await departmentRef(li.location, company);
    const line = { Amount: li.amount, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: detail };
    if (li.description) line.Description = li.description;
    out.push(line);
  }
  return out;
}

// Sales transactions (Invoice/Estimate/SalesReceipt/CreditMemo/RefundReceipt).
export async function buildSalesLines(lines, company) {
  const out = [];
  for (const li of lines) {
    const detail = {};
    if (li.item) detail.ItemRef = await resolveRef("Item", li.item, company, "Name");
    else { const it = await findAnyServiceItem(company); if (it) detail.ItemRef = { value: it.Id, name: it.Name }; }
    if (li.quantity != null) detail.Qty = li.quantity;
    if (li.unit_price != null) detail.UnitPrice = li.unit_price;
    if (li.class) detail.ClassRef = await classRef(li.class, company);
    if (li.tax_code) detail.TaxCodeRef = await taxCodeRef(li.tax_code, company);
    const line = { Amount: li.amount, DetailType: "SalesItemLineDetail", SalesItemLineDetail: detail };
    if (li.description) line.Description = li.description;
    out.push(line);
  }
  return out;
}

// Account-based expense lines (account-based Bill / Expense / VendorCredit).
export async function buildAccountLines(lines, company) {
  const out = [];
  for (const li of lines) {
    const detail = { AccountRef: await resolveRef("Account", li.account, company, "Name") };
    if (li.class) detail.ClassRef = await classRef(li.class, company);
    const line = {
      Amount: li.amount,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: detail,
    };
    if (li.description) line.Description = li.description;
    out.push(line);
  }
  return out;
}

// Item-based expense lines (item-based Bill / PurchaseOrder).
export async function buildItemExpenseLines(lines, company) {
  const out = [];
  for (const li of lines) {
    const detail = { ItemRef: await resolveRef("Item", li.item, company, "Name") };
    if (li.quantity != null) detail.Qty = li.quantity;
    if (li.unit_price != null) detail.UnitPrice = li.unit_price;
    if (li.class) detail.ClassRef = await classRef(li.class, company);
    const line = { Amount: li.amount, DetailType: "ItemBasedExpenseLineDetail", ItemBasedExpenseLineDetail: detail };
    if (li.description) line.Description = li.description;
    out.push(line);
  }
  return out;
}

// Deposit lines.
export async function buildDepositLines(lines, company) {
  const out = [];
  for (const li of lines) {
    const detail = { AccountRef: await resolveRef("Account", li.account, company, "Name") };
    if (li.entity_name) {
      if (!li.entity_type) throw new Error("entity_type is required when entity_name is set on a deposit line.");
      detail.Entity = await resolveRef(li.entity_type, li.entity_name, company);
    }
    if (li.class) detail.ClassRef = await classRef(li.class, company);
    const line = { Amount: li.amount, DetailType: "DepositLineDetail", DepositLineDetail: detail };
    if (li.description) line.Description = li.description;
    out.push(line);
  }
  return out;
}
