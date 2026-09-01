// Startup-time tool profiles for the QBO MCP server.
//
// This module is deliberately independent of index.js. The server asks
// shouldRegisterTool() before registering each tool, while tests and other
// hosts can inspect the same capability map without starting the MCP server.
//
// Profiles fail closed: a tool that has not been assigned to a capability is
// hidden from every curated profile. `full` is the explicit compatibility mode
// and preserves the historical behavior of registering every tool.

export const TOOL_PROFILE_ENV = "QBO_TOOL_PROFILE";
// Keep the default genuinely task-sized. MCP clients have to place every tool
// name, description, and schema in model context; exposing a hundred tools by
// default makes selection worse even when each individual tool is useful.
// `accountant` remains the broad opt-in professional surface.
export const DEFAULT_TOOL_PROFILE = "core";

const freezeList = (values) => Object.freeze([...values]);

export const TOOL_CAPABILITY_GROUPS = Object.freeze({
  company_context: freezeList([
    "list_companies",
    "select_company",
    "get_active_company",
    "health_check",
    "list_clients",
    "resolve_client",
    "get_company_info",
    "get_preferences",
    "get_company_policy",
    "list_unresolved_writes",
  ]),

  financial_summary: freezeList([
    "get_profit_and_loss",
    "get_balance_sheet",
    "get_cash_flow",
    "get_aged_receivables",
    "get_aged_payables",
  ]),

  // The high-frequency MHPE/public-fork surface: enough for routine reporting,
  // AR/AP, bank coding, close review, and journal work without loading every
  // specialist entity and report into each conversation.
  workflow_core: freezeList([
    "get_invoices",
    "get_overdue_invoices",
    "get_payments",
    "get_bills",
    "get_bill_payments",
    "search_customers",
    "search_vendors",
    "search_accounts",
    "search_items",
    "create_customer",
    "update_customer",
    "create_vendor",
    "update_vendor",
    "create_invoice",
    "update_invoice",
    "send_invoice_email",
    "create_payment",
    "create_bill",
    "update_bill",
    "create_bill_payment",
    "create_expense",
    "update_purchase",
    "create_deposit",
    "create_transfer",
    "preview_bank_csv_import",
    "import_transactions_from_csv",
    "reconcile_bank_csv",
    "get_profit_and_loss_detail",
    "get_general_ledger",
    "get_trial_balance",
    "get_changes_since",
    "get_transaction_links",
    "find_duplicate_transactions",
    "create_journal_entry",
    "update_journal_entry",
    "create_reversing_journal_entry",
    "get_consolidated_profit_and_loss",
    "get_consolidated_balance_sheet",
    "get_invoice_pdf",
    "export_qbo_artifact",
    "get_attachments",
    "download_attachment",
    // Aged detail and recurring templates are read-only, and the close-review
    // prompts require them. Without these three, registerWorkflowPrompt
    // correctly refused to advertise month-end-data-pack,
    // close-readiness-review, and collections-review, so the default profile
    // silently delivered 3 of 6 prompts while its own description promised
    // close review.
    "get_aged_receivables_detail",
    "get_aged_payables_detail",
    "get_recurring_transactions",
  ]),

  receivables: freezeList([
    "get_invoices",
    "get_overdue_invoices",
    "get_payments",
    "get_estimates",
    "search_customers",
    "search_items",
    "search_terms",
    "search_payment_methods",
    "search_tax_codes",
    "create_customer",
    "update_customer",
    "create_item",
    "update_item",
    "create_invoice",
    "update_invoice",
    "send_invoice_email",
    "create_estimate",
    "update_estimate",
    "send_estimate",
    "create_invoice_from_estimate",
    "create_sales_receipt",
    "update_sales_receipt",
    "send_sales_receipt",
    "create_credit_memo",
    "create_refund_receipt",
    "create_payment",
  ]),

  payables: freezeList([
    "get_bills",
    "get_bill_payments",
    "search_vendors",
    "create_bill",
    "create_bill_item_based",
    "update_bill",
    "create_vendor_credit",
    "create_purchase_order",
    "create_vendor",
    "update_vendor",
    "create_bill_payment",
  ]),

  banking: freezeList([
    "create_deposit",
    "create_expense",
    "update_purchase",
    "create_transfer",
    "preview_bank_csv_import",
    "import_transactions_from_csv",
    "reconcile_bank_csv",
  ]),

  master_data: freezeList([
    "search_accounts",
    "create_account",
    "update_account",
    "create_employee",
    "update_employee",
    "create_class",
    "update_class",
    "create_department",
    "update_department",
    "create_payment_method",
    "create_term",
  ]),

  time_tracking: freezeList([
    "create_time_activity",
    "get_unbilled_time",
  ]),

  accounting_reports: freezeList([
    "get_profit_and_loss_detail",
    "get_aged_receivables_detail",
    "get_aged_payables_detail",
    "get_general_ledger",
    "get_trial_balance",
    "get_inventory_valuation",
    "get_item_sales",
    "get_transaction_list",
    "get_transaction_list_by_vendor",
    "get_transaction_list_by_customer",
    "get_transaction_list_with_splits",
    "get_general_ledger_flat",
    "get_customer_balance",
    "get_sales_by_customer",
    "get_vendor_balance",
    "get_vendor_expenses",
    "get_budgets",
  ]),

  journal_entries: freezeList([
    "create_journal_entry",
    "update_journal_entry",
    "create_reversing_journal_entry",
  ]),

  review: freezeList([
    "get_changes_since",
    "get_recurring_transactions",
    "get_transaction_links",
    "find_duplicate_transactions",
  ]),

  multi_company: freezeList([
    "get_consolidated_profit_and_loss",
    "get_consolidated_balance_sheet",
    "create_journal_entry_multi",
  ]),

  documents: freezeList([
    "get_invoice_pdf",
    "get_estimate_pdf",
    "export_qbo_artifact",
    "attach_file",
    "get_attachments",
    "download_attachment",
  ]),

  destructive_corrections: freezeList([
    "void_invoice",
    "void_payment",
    "void_sales_receipt",
  ]),

  // Naming the firm's own labels is everyday work and touches only the local
  // clients.json roster: registerClient() cannot bind a token, change a realm
  // mapping, or create a company. Editing the write guardrails is a different
  // kind of act, so the two are separate capabilities. Bundled together, the
  // task-sized default profile could lift a company's read_only flag while the
  // broader bookkeeper profile could not, which inverted least privilege in
  // the one place it matters most.
  client_labels: freezeList([
    "register_client",
  ]),

  policy_administration: freezeList([
    "set_company_policy",
  ]),

  authorization: freezeList([
    "connect_company",
    "check_connection",
    "cancel_connection",
  ]),

  raw_api: freezeList([
    "query",
    "api_get",
    "api_request",
    "execute_batch",
  ]),

  permanent_delete: freezeList([
    "delete_transaction",
  ]),
});

const OWNER_CAPABILITIES = freezeList([
  "company_context",
  "financial_summary",
  "receivables",
  "payables",
  "documents",
]);

const BOOKKEEPER_CAPABILITIES = freezeList([
  ...OWNER_CAPABILITIES,
  "banking",
  "master_data",
  "time_tracking",
  "accounting_reports",
  "review",
  "destructive_corrections",
  // Also fixes the mirror image of the same inversion: core could name a
  // client while the broader bookkeeper profile could not.
  "client_labels",
]);

const ACCOUNTANT_CAPABILITIES = freezeList([
  ...BOOKKEEPER_CAPABILITIES,
  "journal_entries",
  "multi_company",
  "policy_administration",
]);

export const TOOL_PROFILES = Object.freeze({
  core: Object.freeze({
    description: "Task-sized everyday firm surface for reporting, AR/AP, banking, close review, and journal work.",
    capabilities: freezeList(["company_context", "financial_summary", "workflow_core", "client_labels"]),
  }),
  owner: Object.freeze({
    description: "Common company context, financial summaries, sales, bills, and documents.",
    capabilities: OWNER_CAPABILITIES,
  }),
  bookkeeper: Object.freeze({
    description: "Owner tools plus banking, list maintenance, detailed reports, review, and reversible corrections.",
    capabilities: BOOKKEEPER_CAPABILITIES,
  }),
  accountant: Object.freeze({
    description: "Bookkeeper tools plus journal entries, multi-company accounting, client labels, and local write policies.",
    capabilities: ACCOUNTANT_CAPABILITIES,
  }),
  admin: Object.freeze({
    description: "Connection, roster, policy, diagnostics, and company context only.",
    capabilities: freezeList(["company_context", "client_labels", "policy_administration", "authorization"]),
  }),
  developer: Object.freeze({
    description: "Accountant and authorization tools plus raw QBO API access; destructive raw calls and permanent delete require full.",
    capabilities: freezeList([...ACCOUNTANT_CAPABILITIES, "authorization", "raw_api"]),
  }),
  full: Object.freeze({
    description: "Compatibility profile: register every tool, including raw API access and permanent delete.",
    capabilities: freezeList(Object.keys(TOOL_CAPABILITY_GROUPS)),
  }),
});

export const TOOL_PROFILE_NAMES = freezeList(Object.keys(TOOL_PROFILES));

const toolNamesByCapability = new Map(
  Object.entries(TOOL_CAPABILITY_GROUPS).map(([capability, names]) => [capability, new Set(names)])
);

export const KNOWN_TOOL_NAMES = freezeList(
  [...new Set(Object.values(TOOL_CAPABILITY_GROUPS).flat())].sort()
);

/**
 * Parse a profile value from configuration. Missing or blank means the safe,
 * curated default; a misspelling throws rather than silently exposing tools.
 */
export function parseToolProfile(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_TOOL_PROFILE;
  const normalized = String(value).trim().toLowerCase();
  if (!Object.hasOwn(TOOL_PROFILES, normalized)) {
    throw new Error(
      `Invalid ${TOOL_PROFILE_ENV} value "${value}". ` +
      `Choose one of: ${TOOL_PROFILE_NAMES.join(", ")}. ` +
      `No tools were selected; fix the value and restart the connector.`
    );
  }
  return normalized;
}

/** Resolve the startup profile from an env-like object (process.env by default). */
export function toolProfileFromEnv(env = process.env) {
  return parseToolProfile(env?.[TOOL_PROFILE_ENV]);
}

/** Return the capability names enabled by a validated profile. */
export function capabilitiesForProfile(profile = DEFAULT_TOOL_PROFILE) {
  return TOOL_PROFILES[parseToolProfile(profile)].capabilities;
}

/**
 * Decide whether a named tool belongs in a startup profile.
 *
 * Unknown tools are hidden from curated profiles so a newly added escape hatch
 * cannot become public accidentally. `full` deliberately returns true for any
 * tool name to preserve the connector's pre-profile registration behavior.
 */
export function shouldRegisterTool(name, profile = DEFAULT_TOOL_PROFILE) {
  const selected = parseToolProfile(profile);
  if (selected === "full") return true;
  if (typeof name !== "string" || name.length === 0) return false;
  return TOOL_PROFILES[selected].capabilities.some(
    (capability) => toolNamesByCapability.get(capability)?.has(name)
  );
}
