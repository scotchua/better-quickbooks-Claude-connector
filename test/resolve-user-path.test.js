// resolveUserPath: the QBO_FILES_DIR fence, symlink containment, the
// credential-filename refusal, and the clobber guard.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { resolveUserPath } from "../src/util.js";

const HOME = homedir();
const SCRATCH_ROOT = path.join(tmpdir(), `qbo-resolve-user-path-${process.pid}`);
const scratchPath = (...parts) => path.join(SCRATCH_ROOT, ...parts);

afterEach(() => {
  delete process.env.QBO_FILES_DIR;
});

describe("resolveUserPath", () => {
  it("expands ~ and resolves to an absolute path", async () => {
    expect(await resolveUserPath("~/statements/june.csv")).toBe(path.join(HOME, "statements", "june.csv"));
  });

  it("normalizes either separator style in QBO_FILES_DIR and user paths", async () => {
    const relative = "qbo-home-expansion-test/clients/acme/bank.csv";
    const expected = path.join(HOME, ...relative.split("/"));

    process.env.QBO_FILES_DIR = "~\\qbo-home-expansion-test\\clients";
    expect(await resolveUserPath(`~/${relative}`)).toBe(expected);

    process.env.QBO_FILES_DIR = "~/qbo-home-expansion-test/clients";
    expect(await resolveUserPath(`~\\${relative.replaceAll("/", "\\")}`)).toBe(expected);
  });

  it("refuses credential-shaped basenames regardless of QBO_FILES_DIR", async () => {
    await expect(resolveUserPath("~/anything/.env")).rejects.toThrow(/credential-shaped/);
    await expect(resolveUserPath(path.join(tmpdir(), "tokens.acme.json"))).rejects.toThrow(/credential-shaped/);
    await expect(resolveUserPath("~/x/.qbo-key")).rejects.toThrow(/credential-shaped/);
    await expect(resolveUserPath(path.join(tmpdir(), "id_rsa"))).rejects.toThrow(/credential-shaped/);
  });

  it("allows anything when QBO_FILES_DIR is unset", async () => {
    const report = scratchPath("unfenced", "some", "report.csv");
    expect(await resolveUserPath(report)).toBe(report);
  });

  it("fences paths inside QBO_FILES_DIR when set", async () => {
    const base = scratchPath("fence", "clients");
    const inside = path.join(base, "acme", "bank.csv");
    process.env.QBO_FILES_DIR = base;
    expect(await resolveUserPath(inside)).toBe(inside);
    await expect(resolveUserPath(scratchPath("fence", "other", "bank.csv")))
      .rejects.toThrow(/outside QBO_FILES_DIR/);
    // A sibling directory sharing the prefix must not slip through.
    await expect(resolveUserPath(scratchPath("fence", "clients-evil", "bank.csv")))
      .rejects.toThrow(/outside QBO_FILES_DIR/);
  });

  it("normalizes traversal before fencing", async () => {
    const base = scratchPath("traversal", "clients");
    process.env.QBO_FILES_DIR = base;
    await expect(resolveUserPath(path.join(base, "..", "secrets", "x.csv")))
      .rejects.toThrow(/outside QBO_FILES_DIR/);
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
    // Windows directory symlinks require Developer Mode or elevation, while a
    // directory junction exercises the same realpath escape without either.
    await symlink(outside, path.join(inside, "escape"), process.platform === "win32" ? "junction" : "dir");

    try {
      process.env.QBO_FILES_DIR = inside;
      // The lexical path looks contained; the real one is not.
      await expect(resolveUserPath(path.join(inside, "escape", "payroll.csv")))
        .rejects.toThrow(/outside QBO_FILES_DIR/);
      // A real file actually inside the tree still resolves.
      await writeFile(path.join(inside, "bank.csv"), "x");
      expect(await resolveUserPath(path.join(inside, "bank.csv"))).toBe(path.join(inside, "bank.csv"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still fences a write whose parent directory does not exist yet", async () => {
    const base = scratchPath("write-fence", "clients");
    const inside = path.join(base, "new", "deep", "out.json");
    process.env.QBO_FILES_DIR = base;
    expect(await resolveUserPath(inside, { purpose: "write" })).toBe(inside);
    await expect(resolveUserPath(scratchPath("write-fence", "elsewhere", "new", "out.json"), { purpose: "write" }))
      .rejects.toThrow(/outside QBO_FILES_DIR/);
  });

  // attach_file uploads a local file into QuickBooks, so an unconstrained path
  // is an exfiltration route rather than merely a mistake.
  it("requireBase refuses to run at all when QBO_FILES_DIR is unset", async () => {
    const base = scratchPath("required-fence", "clients");
    const inside = path.join(base, "receipt.pdf");
    const outside = scratchPath("required-fence", "outside", "hosts");
    await expect(resolveUserPath(outside, { requireBase: true })).rejects.toThrow(/QBO_FILES_DIR is not set/);
    process.env.QBO_FILES_DIR = base;
    expect(await resolveUserPath(inside, { requireBase: true })).toBe(inside);
    await expect(resolveUserPath(outside, { requireBase: true })).rejects.toThrow(/outside QBO_FILES_DIR/);
  });

  it("refuses to clobber an existing file on write unless told to", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qbo-clobber-"));
    const file = path.join(dir, "already-here.json");
    await writeFile(file, "important");

    try {
      await expect(resolveUserPath(file, { purpose: "write" })).rejects.toThrow(/Refusing to overwrite/);
      expect(await resolveUserPath(file, { purpose: "write", overwrite: true })).toBe(file);
      // Reads are unaffected, and a new path is fine.
      expect(await resolveUserPath(file)).toBe(file);
      expect(await resolveUserPath(path.join(dir, "fresh.json"), { purpose: "write" })).toBe(path.join(dir, "fresh.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
