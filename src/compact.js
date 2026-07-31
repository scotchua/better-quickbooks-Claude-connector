// compact.js: trimmed response shapes for list-returning tools.
//
// Full QBO entities are hundreds of lines each; lists of them overwhelm the
// conversation. Compact shapes keep the fields an accountant acts on. Every
// list tool takes `verbose: true` to get the raw entities instead.

const ref = (r) => r?.name ?? r?.value ?? null;

const SHAPES = {
  Invoice: (e) => ({
    Id: e.Id, DocNumber: e.DocNumber, TxnDate: e.TxnDate, DueDate: e.DueDate,
    Customer: ref(e.CustomerRef), TotalAmt: e.TotalAmt, Balance: e.Balance,
    EmailStatus: e.EmailStatus,
  }),
  Estimate: (e) => ({
    Id: e.Id, DocNumber: e.DocNumber, TxnDate: e.TxnDate, ExpirationDate: e.ExpirationDate,
    Customer: ref(e.CustomerRef), TotalAmt: e.TotalAmt, TxnStatus: e.TxnStatus,
  }),
  Bill: (e) => ({
    Id: e.Id, DocNumber: e.DocNumber, TxnDate: e.TxnDate, DueDate: e.DueDate,
    Vendor: ref(e.VendorRef), TotalAmt: e.TotalAmt, Balance: e.Balance,
  }),
  BillPayment: (e) => ({
    Id: e.Id, DocNumber: e.DocNumber, TxnDate: e.TxnDate, Vendor: ref(e.VendorRef),
    TotalAmt: e.TotalAmt, PayType: e.PayType,
  }),
  Payment: (e) => ({
    Id: e.Id, TxnDate: e.TxnDate, Customer: ref(e.CustomerRef),
    TotalAmt: e.TotalAmt, UnappliedAmt: e.UnappliedAmt,
  }),
  Customer: (e) => ({
    Id: e.Id, DisplayName: e.DisplayName, CompanyName: e.CompanyName,
    Email: e.PrimaryEmailAddr?.Address ?? null, Phone: e.PrimaryPhone?.FreeFormNumber ?? null,
    Balance: e.Balance, Active: e.Active,
  }),
  Vendor: (e) => ({
    Id: e.Id, DisplayName: e.DisplayName, CompanyName: e.CompanyName,
    Email: e.PrimaryEmailAddr?.Address ?? null, Phone: e.PrimaryPhone?.FreeFormNumber ?? null,
    Balance: e.Balance, Active: e.Active, Vendor1099: e.Vendor1099,
  }),
  Item: (e) => ({
    Id: e.Id, Name: e.Name, Type: e.Type, UnitPrice: e.UnitPrice,
    IncomeAccount: ref(e.IncomeAccountRef), Active: e.Active,
  }),
  Account: (e) => ({
    Id: e.Id, Name: e.Name, AcctNum: e.AcctNum, AccountType: e.AccountType,
    AccountSubType: e.AccountSubType, CurrentBalance: e.CurrentBalance, Active: e.Active,
  }),
};

export function compactList(entity, rows, verbose = false) {
  if (verbose || !SHAPES[entity]) return rows;
  return rows.map(SHAPES[entity]);
}
