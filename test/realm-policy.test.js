// Write guardrails must resolve by QuickBooks REALM, not by company slug.
//
// The defect these cover: a realm authorized under two slugs could have
// read_only set on one label while writes addressed to the other label still
// posted, because policyFor() read companies[slug] and nothing else. A realm is
// the set of books; a slug is a local nickname in a filename; the guardrail
// belongs to the books.
//
// The `siblings` injection keeps these tests off the real token directory.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { policyFor, checkWritePolicy } from "../src/policy.js";
import { realmSiblingSlugs, duplicateRealms } from "../src/company-registry.js";

afterEach(() => {
  delete process.env.QBO_POLICY_FILE;
});

async function withPolicy(policy) {
  const dir = await mkdtemp(path.join(tmpdir(), "qbo-realm-policy-"));
  const file = path.join(dir, "qbo-policy.json");
  await writeFile(file, JSON.stringify(policy));
  process.env.QBO_POLICY_FILE = file;
}

const BOTH = ["books-a", "books-b"];

describe("realm-scoped write policy", () => {
  it("applies a read_only flag set on a sibling slug for the same realm", async () => {
    await withPolicy({ companies: { "books-b": { read_only: true } } });
    // Nothing at all is configured under books-a.
    expect(await policyFor("books-a", { siblings: BOTH })).toMatchObject({ read_only: true });
    await expect(checkWritePolicy("books-a", null, { siblings: BOTH }))
      .rejects.toThrow(/read-only/i);
  });

  it("takes the LOWEST amount cap across slugs for one realm", async () => {
    await withPolicy({
      companies: { "books-a": { max_write_amount: 10000 }, "books-b": { max_write_amount: 500 } },
    });
    expect(await policyFor("books-a", { siblings: BOTH })).toMatchObject({ max_write_amount: 500 });
    // Within the strictest cap the firm keeps working, which is the whole
    // reason this merges rather than blocking every write outright.
    await expect(checkWritePolicy("books-a", { TotalAmt: 400 }, { siblings: BOTH })).resolves.toBeUndefined();
    await expect(checkWritePolicy("books-a", { TotalAmt: 900 }, { siblings: BOTH }))
      .rejects.toThrow(/above the .* limit of 500/);
  });

  it("takes the LATEST date floor across slugs for one realm", async () => {
    await withPolicy({
      companies: { "books-a": { min_txn_date: "2026-01-01" }, "books-b": { min_txn_date: "2026-06-30" } },
    });
    expect(await policyFor("books-a", { siblings: BOTH })).toMatchObject({ min_txn_date: "2026-06-30" });
    await expect(checkWritePolicy("books-a", { TxnDate: "2026-03-15" }, { siblings: BOTH }))
      .rejects.toThrow(/before the .* floor of 2026-06-30/);
  });

  it("is independent of slug ordering", async () => {
    await withPolicy({
      companies: { "books-a": { max_write_amount: 9000 }, "books-b": { read_only: true, max_write_amount: 250 } },
    });
    const forward = await policyFor("books-a", { siblings: ["books-a", "books-b"] });
    const reverse = await policyFor("books-b", { siblings: ["books-b", "books-a"] });
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({ read_only: true, max_write_amount: 250 });
  });

  it("resolves identically no matter which slug the caller explicitly targeted", async () => {
    await withPolicy({ companies: { "books-b": { read_only: true } } });
    for (const target of BOTH) {
      await expect(checkWritePolicy(target, null, { siblings: BOTH }), target)
        .rejects.toThrow(/read-only/i);
    }
  });

  it("leaves equal policies unchanged and still permits the write", async () => {
    await withPolicy({
      companies: { "books-a": { max_write_amount: 1000 }, "books-b": { max_write_amount: 1000 } },
    });
    expect(await policyFor("books-a", { siblings: BOTH })).toMatchObject({ max_write_amount: 1000 });
    await expect(checkWritePolicy("books-a", { TotalAmt: 999 }, { siblings: BOTH })).resolves.toBeUndefined();
  });

  it("still lets a company rule reopen a deny-by-default policy", async () => {
    // Regression on the merge itself. Folding `defaults` in strictest would OR
    // read_only to true and make a locked company impossible to reopen, which
    // is the documented deny-by-default pattern.
    await withPolicy({ defaults: { read_only: true }, companies: { solo: { read_only: false } } });
    expect(await policyFor("solo", { siblings: ["solo"] })).toMatchObject({ read_only: false });
    await expect(checkWritePolicy("solo", null, { siblings: ["solo"] })).resolves.toBeUndefined();
  });

  it("still applies defaults to a slug with no rules of its own", async () => {
    await withPolicy({ defaults: { max_write_amount: 100 } });
    expect(await policyFor("books-a", { siblings: BOTH })).toMatchObject({ max_write_amount: 100 });
  });

  it("keeps a sibling's stricter rule over an inherited default", async () => {
    await withPolicy({
      defaults: { max_write_amount: 5000 },
      companies: { "books-b": { max_write_amount: 50 } },
    });
    expect(await policyFor("books-a", { siblings: BOTH })).toMatchObject({ max_write_amount: 50 });
  });

  it("behaves exactly as before for a single-slug realm", async () => {
    await withPolicy({ defaults: { read_only: true }, companies: { solo: { read_only: false, max_write_amount: 42 } } });
    expect(await policyFor("solo", { siblings: ["solo"] })).toEqual({ read_only: false, max_write_amount: 42 });
  });

  it("returns no rules when there is no policy file at all", async () => {
    process.env.QBO_POLICY_FILE = path.join(tmpdir(), "qbo-realm-policy-absent", "nope.json");
    expect(await policyFor("books-a", { siblings: BOTH })).toEqual({});
  });
});

describe("company registry realm identity", () => {
  it("returns the slug itself when it is unknown or has no realm", async () => {
    expect(await realmSiblingSlugs("not-authorized", [])).toEqual(["not-authorized"]);
    expect(await realmSiblingSlugs("no-realm", [{ slug: "no-realm", realmId: null, environment: "sandbox" }]))
      .toEqual(["no-realm"]);
  });

  it("groups every slug that addresses the same realm", async () => {
    const companies = [
      { slug: "books-a", realmId: "123", environment: "production" },
      { slug: "books-b", realmId: "123", environment: "production" },
      { slug: "other", realmId: "999", environment: "sandbox" },
    ];
    expect((await realmSiblingSlugs("books-a", companies)).sort()).toEqual(["books-a", "books-b"]);
    expect(await realmSiblingSlugs("other", companies)).toEqual(["other"]);
  });

  it("includes the legacy default identity in same-realm policy groups", async () => {
    const companies = [
      { slug: "", realmId: "123", environment: "production" },
      { slug: "books-a", realmId: "123", environment: "production" },
    ];
    expect((await realmSiblingSlugs("", companies)).sort()).toEqual(["", "books-a"]);
    expect((await realmSiblingSlugs("books-a", companies)).sort()).toEqual(["", "books-a"]);
    const [duplicate] = await duplicateRealms(companies);
    expect(duplicate).toMatchObject({ realmId: "123", slugs: ["", "books-a"] });
  });

  it("compares realm ids as strings so a numeric token value still matches", async () => {
    const companies = [
      { slug: "books-a", realmId: 123, environment: "production" },
      { slug: "books-b", realmId: "123", environment: "production" },
    ];
    expect((await realmSiblingSlugs("books-a", companies)).sort()).toEqual(["books-a", "books-b"]);
  });

  it("reports duplicate realms for the doctor, and nothing when identities are distinct", async () => {
    expect(await duplicateRealms([
      { slug: "a", realmId: "1", environment: "production" },
      { slug: "b", realmId: "2", environment: "production" },
    ])).toEqual([]);

    const dupes = await duplicateRealms([
      { slug: "books-a", realmId: "1", environment: "production" },
      { slug: "books-b", realmId: "1", environment: "production" },
      { slug: "solo", realmId: "2", environment: "sandbox" },
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toMatchObject({ realmId: "1" });
    expect(dupes[0].slugs.sort()).toEqual(["books-a", "books-b"]);
  });
});

describe("duplicate-realm authorization guard", () => {
  it("fails closed when the realm id is missing", async () => {
    const { assertRealmNotAlreadyAuthorized } = await import("../src/qbo.js");
    for (const realm of [null, undefined, "", "   "]) {
      await expect(assertRealmNotAlreadyAuthorized("some-slug", realm), String(realm))
        .rejects.toThrow(/without a QuickBooks realm id/);
    }
  });

  it("compares slugs on the same canonical form the token filename uses", async () => {
    // The guard sanitizes, tokensPathFor sanitizes, and the registry only ever
    // returns slugs matching ^[A-Za-z0-9_-]+$ (it throws otherwise), so a raw
    // caller slug cannot self-exclude from a differently-cased stored key.
    const { sanitizeSlug } = await import("../src/qbo.js");
    for (const raw of ["acme", "acme-co", "acme_1", "Acme Co!", " acme "]) {
      expect(sanitizeSlug(sanitizeSlug(raw))).toBe(sanitizeSlug(raw));
    }
    expect(sanitizeSlug("Acme Co!")).toBe("AcmeCo");
  });
});
