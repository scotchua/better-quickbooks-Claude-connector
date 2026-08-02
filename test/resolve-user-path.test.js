// resolveUserPath: the QBO_FILES_DIR fence and the credential-filename refusal.
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { resolveUserPath } from "../src/util.js";

const HOME = process.env.HOME || "/tmp";

afterEach(() => {
  delete process.env.QBO_FILES_DIR;
});

describe("resolveUserPath", () => {
  it("expands ~ and resolves to an absolute path", () => {
    expect(resolveUserPath("~/statements/june.csv")).toBe(path.join(HOME, "statements", "june.csv"));
  });

  it("refuses credential-shaped basenames regardless of QBO_FILES_DIR", () => {
    expect(() => resolveUserPath("~/anything/.env")).toThrow(/credential-shaped/);
    expect(() => resolveUserPath("/tmp/tokens.acme.json")).toThrow(/credential-shaped/);
    expect(() => resolveUserPath("~/x/.qbo-key")).toThrow(/credential-shaped/);
    expect(() => resolveUserPath("/tmp/id_rsa")).toThrow(/credential-shaped/);
  });

  it("allows anything when QBO_FILES_DIR is unset", () => {
    expect(resolveUserPath("/tmp/some/report.csv")).toBe("/tmp/some/report.csv");
  });

  it("fences paths inside QBO_FILES_DIR when set", () => {
    process.env.QBO_FILES_DIR = "/tmp/clients";
    expect(resolveUserPath("/tmp/clients/acme/bank.csv")).toBe("/tmp/clients/acme/bank.csv");
    expect(() => resolveUserPath("/tmp/other/bank.csv")).toThrow(/outside QBO_FILES_DIR/);
    // A sibling directory sharing the prefix must not slip through.
    expect(() => resolveUserPath("/tmp/clients-evil/bank.csv")).toThrow(/outside QBO_FILES_DIR/);
  });

  it("normalizes traversal before fencing", () => {
    process.env.QBO_FILES_DIR = "/tmp/clients";
    expect(() => resolveUserPath("/tmp/clients/../secrets/x.csv")).toThrow(/outside QBO_FILES_DIR/);
  });
});
