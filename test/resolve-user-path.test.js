// resolveUserPath: the QBO_FILES_DIR fence, symlink containment, the
// credential-filename refusal, and the clobber guard.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { resolveUserPath } from "../src/util.js";

const HOME = process.env.HOME || "/tmp";

afterEach(() => {
  delete process.env.QBO_FILES_DIR;
});

describe("resolveUserPath", () => {
  it("expands ~ and resolves to an absolute path", async () => {
    expect(await resolveUserPath("~/statements/june.csv")).toBe(path.join(HOME, "statements", "june.csv"));
  });

  it("refuses credential-shaped basenames regardless of QBO_FILES_DIR", async () => {
    await expect(resolveUserPath("~/anything/.env")).rejects.toThrow(/credential-shaped/);
    await expect(resolveUserPath("/tmp/tokens.acme.json")).rejects.toThrow(/credential-shaped/);
    await expect(resolveUserPath("~/x/.qbo-key")).rejects.toThrow(/credential-shaped/);
    await expect(resolveUserPath("/tmp/id_rsa")).rejects.toThrow(/credential-shaped/);
  });

  it("allows anything when QBO_FILES_DIR is unset", async () => {
    expect(await resolveUserPath("/tmp/some/report.csv")).toBe("/tmp/some/report.csv");
  });

  it("fences paths inside QBO_FILES_DIR when set", async () => {
    process.env.QBO_FILES_DIR = "/tmp/clients";
    expect(await resolveUserPath("/tmp/clients/acme/bank.csv")).toBe("/tmp/clients/acme/bank.csv");
    await expect(resolveUserPath("/tmp/other/bank.csv")).rejects.toThrow(/outside QBO_FILES_DIR/);
    // A sibling directory sharing the prefix must not slip through.
    await expect(resolveUserPath("/tmp/clients-evil/bank.csv")).rejects.toThrow(/outside QBO_FILES_DIR/);
  });

  it("normalizes traversal before fencing", async () => {
    process.env.QBO_FILES_DIR = "/tmp/clients";
    await expect(resolveUserPath("/tmp/clients/../secrets/x.csv")).rejects.toThrow(/outside QBO_FILES_DIR/);
  });

  // A lexical prefix check passes a symlink that points anywhere, which makes
  // the fence decorative: drop one link inside the tree and read the whole disk.
  it("refuses a symlink inside the fence that points outside it", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "qbo-fence-")));
    const inside = path.join(root, "clients");
    const outside = path.join(root, "secrets");
    await mkdir(inside);
    await mkdir(outside);
    await writeFile(path.join(outside, "payroll.csv"), "x");
    await symlink(outside, path.join(inside, "escape"));

    process.env.QBO_FILES_DIR = inside;
    // The lexical path looks contained; the real one is not.
    await expect(resolveUserPath(path.join(inside, "escape", "payroll.csv")))
      .rejects.toThrow(/outside QBO_FILES_DIR/);
    // A real file actually inside the tree still resolves.
    await writeFile(path.join(inside, "bank.csv"), "x");
    expect(await resolveUserPath(path.join(inside, "bank.csv"))).toBe(path.join(inside, "bank.csv"));
  });

  it("still fences a write whose parent directory does not exist yet", async () => {
    process.env.QBO_FILES_DIR = "/tmp/clients";
    expect(await resolveUserPath("/tmp/clients/new/deep/out.json", { purpose: "write" }))
      .toBe("/tmp/clients/new/deep/out.json");
    await expect(resolveUserPath("/tmp/elsewhere/new/out.json", { purpose: "write" }))
      .rejects.toThrow(/outside QBO_FILES_DIR/);
  });

  // attach_file uploads a local file into QuickBooks, so an unconstrained path
  // is an exfiltration route rather than merely a mistake.
  it("requireBase refuses to run at all when QBO_FILES_DIR is unset", async () => {
    await expect(resolveUserPath("/etc/hosts", { requireBase: true })).rejects.toThrow(/QBO_FILES_DIR is not set/);
    process.env.QBO_FILES_DIR = "/tmp/clients";
    expect(await resolveUserPath("/tmp/clients/receipt.pdf", { requireBase: true }))
      .toBe("/tmp/clients/receipt.pdf");
    await expect(resolveUserPath("/etc/hosts", { requireBase: true })).rejects.toThrow(/outside QBO_FILES_DIR/);
  });

  it("refuses to clobber an existing file on write unless told to", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-clobber-"));
    const file = path.join(dir, "already-here.json");
    await writeFile(file, "important");

    await expect(resolveUserPath(file, { purpose: "write" })).rejects.toThrow(/Refusing to overwrite/);
    expect(await resolveUserPath(file, { purpose: "write", overwrite: true })).toBe(file);
    // Reads are unaffected, and a new path is fine.
    expect(await resolveUserPath(file)).toBe(file);
    expect(await resolveUserPath(path.join(dir, "fresh.json"), { purpose: "write" })).toBe(path.join(dir, "fresh.json"));
  });
});
