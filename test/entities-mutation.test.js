import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const qbo = vi.hoisted(() => ({ qboQuery: vi.fn(), qboRequest: vi.fn() }));
vi.mock("../src/qbo.js", () => qbo);

import {
  qboQueryAll, nameFieldFor, findByName, suggestNames, notFoundError, resolveRef,
  fetchEntity, readJournalEntry, findCustomerByName, findVendorByName,
  findAccountByName, findAnyIncomeAccount, findAnyServiceItem, closedPeriodMode,
  getBookCloseDate, closedPeriodWarnings, withWarnings,
} from "../src/entities.js";

beforeEach(() => {
  qbo.qboQuery.mockReset();
  qbo.qboRequest.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("qboQueryAll", () => {
  it("pages from position one until a short page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ Id: String(i + 1) }));
    qbo.qboQuery.mockResolvedValueOnce({ Account: firstPage }).mockResolvedValueOnce({ Account: [{ Id: "101" }] });
    const result = await qboQueryAll("SELECT * FROM Account", "Account", { company: "alder-books" });
    expect(result).toEqual({ rows: [...firstPage, { Id: "101" }], truncated: false });
    expect(qbo.qboQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 100",
      "SELECT * FROM Account STARTPOSITION 101 MAXRESULTS 100",
    ]);
  });

  it("marks a full page truncated at the requested ceiling", async () => {
    qbo.qboQuery.mockResolvedValue({ Account: Array.from({ length: 100 }, (_, i) => ({ Id: String(i + 1) })) });
    const result = await qboQueryAll("SELECT * FROM Account", "Account", { company: "birch-books", maxTotal: 100 });
    expect(result).toMatchObject({ truncated: true });
    expect(result.rows).toHaveLength(100);
    expect(qbo.qboQuery).toHaveBeenCalledTimes(1);
  });
});

describe("nameFieldFor", () => {
  it("uses display names for people and names for accounts", () => {
    expect(["Customer", "Vendor", "Employee", "Account"].map(nameFieldFor))
      .toEqual(["DisplayName", "DisplayName", "DisplayName", "Name"]);
  });
});

describe("findByName", () => {
  it("returns an exact match without loading the name index", async () => {
    const customer = { Id: "41", DisplayName: "Cedar Studio" };
    qbo.qboQuery.mockResolvedValue({ Customer: [customer] });
    await expect(findByName("Customer", "Cedar Studio", "cedar-books")).resolves.toEqual(customer);
    expect(qbo.qboQuery).toHaveBeenCalledTimes(1);
  });

  it("does not load an index for a blank name", async () => {
    qbo.qboQuery.mockResolvedValue({ Customer: [] });
    await expect(findByName("Customer", "  ", "dune-books")).resolves.toBeNull();
    expect(qbo.qboQuery).toHaveBeenCalledTimes(1);
  });

  it("resolves a unique normalized match by its validated Id", async () => {
    const customer = { Id: "52", DisplayName: "Maple Works" };
    qbo.qboQuery.mockImplementation(async (sql) => {
      if (sql.includes("WHERE DisplayName")) return { Customer: [] };
      if (sql.includes("STARTPOSITION")) return { Customer: [customer] };
      return { Customer: [customer] };
    });
    await expect(findByName("Customer", " maple   works ", "maple-books")).resolves.toEqual(customer);
    expect(qbo.qboQuery.mock.calls[2][0]).toContain("WHERE Id = '52'");
  });

  it("returns null when a fuzzy match disappears before its Id lookup", async () => {
    qbo.qboQuery.mockImplementation(async (sql) => {
      if (sql.includes("STARTPOSITION")) return { Customer: [{ Id: "53", DisplayName: "Willow Works" }] };
      return { Customer: [] };
    });
    await expect(findByName("Customer", " willow works ", "willow-books")).resolves.toBeNull();
  });
});

describe("suggestNames", () => {
  it("returns matching names in index order and reuses the company index", async () => {
    qbo.qboQuery.mockResolvedValue({ Account: [
      { Id: "61", Name: "Pine Revenue" },
      { Id: "62", Name: "Pine Reserve" },
      { Id: "63", Name: "Oak Expense" },
    ] });
    await expect(suggestNames("Account", " pine ", "pine-books", undefined, 1))
      .resolves.toEqual(["Pine Revenue"]);
    await expect(suggestNames("Account", "pine", "pine-books", undefined, 2))
      .resolves.toEqual(["Pine Revenue", "Pine Reserve"]);
    expect(qbo.qboQuery).toHaveBeenCalledTimes(1);
  });

  it("returns no suggestions when the index query fails", async () => {
    qbo.qboQuery.mockRejectedValue(new Error("offline query failure"));
    await expect(suggestNames("Account", "elm", "elm-books")).resolves.toEqual([]);
  });
});

describe("notFoundError", () => {
  it("includes available suggestions only when supplied", () => {
    expect(notFoundError("Account", "Ash", ["Ash Sales"]).message)
      .toContain('Did you mean: "Ash Sales"?');
    expect(notFoundError("Account", "Ash", []).message).not.toContain("Did you mean");
  });
});

describe("resolveRef", () => {
  it("resolves numeric Ids and preserves an unknown numeric Id", async () => {
    qbo.qboQuery.mockResolvedValueOnce({ Account: [{ Id: "71", Name: "Aspen Income" }] })
      .mockResolvedValueOnce({ Account: [] });
    await expect(resolveRef("Account", "71", "aspen-books")).resolves.toEqual({ value: "71", name: "Aspen Income" });
    await expect(resolveRef("Account", "72", "aspen-books")).resolves.toEqual({ value: "72" });
    expect(qbo.qboQuery.mock.calls[0][0]).toContain("WHERE Id = '71'");
  });

  it("throws a not-found error for an unknown name", async () => {
    qbo.qboQuery.mockResolvedValue({ Account: [] });
    await expect(resolveRef("Account", "Spruce Income", "spruce-books"))
      .rejects.toThrow('Account not found: "Spruce Income"');
  });
});

describe("fetchEntity", () => {
  it("returns a fetched record and rejects a missing Id", async () => {
    const account = { Id: "81", SyncToken: "3" };
    qbo.qboQuery.mockResolvedValueOnce({ Account: [account] }).mockResolvedValueOnce({ Account: [] });
    await expect(fetchEntity("Account", "81", "fir-books")).resolves.toEqual(account);
    await expect(fetchEntity("Account", "82", "fir-books")).rejects.toThrow("No Account with Id 82");
  });
});

describe("readJournalEntry", () => {
  it("returns a journal entry and rejects a missing one", async () => {
    const entry = { Id: "91", TxnDate: "2026-04-08" };
    qbo.qboRequest.mockResolvedValueOnce({ JournalEntry: entry }).mockResolvedValueOnce({});
    await expect(readJournalEntry("91", "oak-books")).resolves.toEqual(entry);
    await expect(readJournalEntry("92", "oak-books")).rejects.toThrow("No journal entry with Id 92");
  });
});

describe("findCustomerByName", () => {
  it("queries customers by display name", async () => {
    const customer = { Id: "101", DisplayName: "Amber Labs" };
    qbo.qboQuery.mockResolvedValue({ Customer: [customer] });
    await expect(findCustomerByName("Amber Labs", "amber-books")).resolves.toEqual(customer);
    expect(qbo.qboQuery.mock.calls[0][0]).toContain("FROM Customer WHERE DisplayName");
  });
});

describe("findVendorByName", () => {
  it("queries vendors by display name", async () => {
    const vendor = { Id: "102", DisplayName: "Bronze Supply" };
    qbo.qboQuery.mockResolvedValue({ Vendor: [vendor] });
    await expect(findVendorByName("Bronze Supply", "bronze-books")).resolves.toEqual(vendor);
    expect(qbo.qboQuery.mock.calls[0][0]).toContain("FROM Vendor WHERE DisplayName");
  });
});

describe("findAccountByName", () => {
  it("queries accounts by name", async () => {
    const account = { Id: "103", Name: "Copper Cash" };
    qbo.qboQuery.mockResolvedValue({ Account: [account] });
    await expect(findAccountByName("Copper Cash", "copper-books")).resolves.toEqual(account);
    expect(qbo.qboQuery.mock.calls[0][0]).toContain("FROM Account WHERE Name");
  });
});

describe("findAnyIncomeAccount", () => {
  it("selects the first income account", async () => {
    const account = { Id: "111", Name: "Larch Income" };
    qbo.qboQuery.mockResolvedValue({ Account: [account] });
    await expect(findAnyIncomeAccount("larch-books")).resolves.toEqual(account);
    expect(qbo.qboQuery.mock.calls[0][0]).toContain("AccountType = 'Income'");
  });
});

describe("findAnyServiceItem", () => {
  it("selects the first service item", async () => {
    const item = { Id: "112", Name: "Elm Consulting" };
    qbo.qboQuery.mockResolvedValue({ Item: [item] });
    await expect(findAnyServiceItem("elm-item-books")).resolves.toEqual(item);
    expect(qbo.qboQuery.mock.calls[0][0]).toContain("Type = 'Service'");
  });
});

describe("closedPeriodMode", () => {
  it("defaults an empty mode to warn", () => {
    vi.stubEnv("QBO_CLOSED_PERIOD", "");
    expect(closedPeriodMode()).toBe("warn");
  });
});

describe("getBookCloseDate", () => {
  it("returns the verified close date from the company cache", async () => {
    qbo.qboRequest.mockResolvedValue({ Preferences: { AccountingInfoPrefs: { BookCloseDate: "2026-04-30" } } });
    await expect(getBookCloseDate("sycamore-books")).resolves.toBe("2026-04-30");
    await expect(getBookCloseDate("sycamore-books")).resolves.toBe("2026-04-30");
    expect(qbo.qboRequest).toHaveBeenCalledTimes(1);
  });
});

describe("closedPeriodWarnings", () => {
  it("treats the book-close date itself as closed", async () => {
    vi.stubEnv("QBO_CLOSED_PERIOD", "warn");
    qbo.qboRequest.mockResolvedValue({ Preferences: { AccountingInfoPrefs: { BookCloseDate: "2026-05-31" } } });
    await expect(closedPeriodWarnings("hickory-books", ["2026-05-31"]))
      .resolves.toEqual([expect.stringContaining("date 2026-05-31")]);
  });
});

describe("withWarnings", () => {
  it("adds nonempty warnings and leaves a clean payload alone", () => {
    const payload = { Id: "121" };
    expect(withWarnings(payload, ["review the date"])).toEqual({ ...payload, warnings: ["review the date"] });
    expect(withWarnings(payload, [])).toBe(payload);
  });
});
