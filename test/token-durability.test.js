import { describe, it, expect, vi } from "vitest";
import { durableAtomicReplace } from "../src/qbo.js";

const fsError = (code, message = code) => Object.assign(new Error(message), { code });

describe("durable token replacement", () => {
  it("syncs the temp file before rename and the directory after rename", async () => {
    const events = [];
    const fileHandle = {
      writeFile: vi.fn(async () => { events.push("write"); }),
      sync: vi.fn(async () => { events.push("file-sync"); }),
      close: vi.fn(async () => { events.push("file-close"); }),
    };
    const directoryHandle = {
      sync: vi.fn(async () => { events.push("directory-sync"); }),
      close: vi.fn(async () => { events.push("directory-close"); }),
    };
    const openFile = vi.fn(async (target, flags, mode) => {
      events.push(`open:${target}:${flags}:${mode ?? ""}`);
      return flags === "wx" ? fileHandle : directoryHandle;
    });
    const move = vi.fn(async (from, to) => { events.push(`rename:${from}:${to}`); });
    const remove = vi.fn();

    await durableAtomicReplace("/tokens/acme.json", "/tokens/acme.tmp", "{}", {
      openFile, move, remove, platform: "linux",
    });

    expect(events).toEqual([
      "open:/tokens/acme.tmp:wx:384",
      "write",
      "file-sync",
      "file-close",
      "rename:/tokens/acme.tmp:/tokens/acme.json",
      "open:/tokens:r:",
      "directory-sync",
      "directory-close",
    ]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("fails closed if the post-rename directory sync fails", async () => {
    const fileHandle = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const directoryHandle = {
      sync: vi.fn(async () => { throw fsError("EIO", "directory flush failed"); }),
      close: vi.fn(async () => {}),
    };
    const openFile = vi.fn()
      .mockResolvedValueOnce(fileHandle)
      .mockResolvedValueOnce(directoryHandle);
    const move = vi.fn(async () => {});
    const remove = vi.fn();

    await expect(durableAtomicReplace("/tokens/acme.json", "/tokens/acme.tmp", "{}", {
      openFile, move, remove, platform: "linux",
    })).rejects.toThrow(/directory flush failed/);
    expect(move).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(directoryHandle.close).toHaveBeenCalledOnce();
  });

  it("removes an owned temp file after a pre-rename durability failure", async () => {
    const fileHandle = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => { throw fsError("EIO", "file flush failed"); }),
      close: vi.fn(async () => {}),
    };
    const openFile = vi.fn(async () => fileHandle);
    const move = vi.fn();
    const remove = vi.fn(async () => {});

    await expect(durableAtomicReplace("/tokens/acme.json", "/tokens/acme.tmp", "{}", {
      openFile, move, remove, platform: "linux",
    })).rejects.toThrow(/file flush failed/);
    expect(fileHandle.close).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("/tokens/acme.tmp");
  });

  it("syncs the file and skips unsupported directory handles on Windows", async () => {
    const fileHandle = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const openFile = vi.fn(async () => fileHandle);
    const move = vi.fn(async () => {});

    await durableAtomicReplace("C:\\tokens\\acme.json", "C:\\tokens\\acme.tmp", "{}", {
      openFile, move, platform: "win32",
    });
    expect(fileHandle.sync).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledOnce();
  });
});
