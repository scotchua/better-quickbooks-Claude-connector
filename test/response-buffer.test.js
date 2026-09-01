import { describe, expect, it, vi } from "vitest";
import { readResponseBuffer } from "../src/util.js";

describe("readResponseBuffer", () => {
  it("validates the configured cap before touching the response", async () => {
    const headers = { get: vi.fn() };
    const body = { getReader: vi.fn(), cancel: vi.fn() };
    const response = { headers, body };

    for (const maxBytes of [undefined, "", "not-a-number", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(readResponseBuffer(response, {
        maxBytes,
        capName: "QBO_PDF_MAX_BYTES",
      })).rejects.toThrow(/QBO_PDF_MAX_BYTES must be a positive safe integer/);
    }
    expect(headers.get).not.toHaveBeenCalled();
    expect(body.getReader).not.toHaveBeenCalled();
  });

  it("rejects an oversized Content-Length before reading and cancels the body", async () => {
    const cancel = vi.fn(async () => {});
    const getReader = vi.fn();
    const response = {
      headers: new Headers({ "content-length": "11" }),
      body: { cancel, getReader },
    };

    await expect(readResponseBuffer(response, {
      maxBytes: 10,
      label: "Attachment",
      capName: "QBO_PDF_MAX_BYTES",
    })).rejects.toThrow(/Attachment declares 11 bytes.*10-byte cap.*QBO_PDF_MAX_BYTES/);
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a chunked response as soon as its running total exceeds the cap", async () => {
    const cancel = vi.fn();
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(chunks.shift());
      },
      cancel,
    });

    await expect(readResponseBuffer(new Response(body), {
      maxBytes: 5,
      label: "Attachment",
      capName: "QBO_PDF_MAX_BYTES",
    })).rejects.toThrow(/Attachment exceeded the 5-byte cap.*at least 6 bytes.*QBO_PDF_MAX_BYTES/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns one Buffer when the streamed body stays within the cap", async () => {
    const result = await readResponseBuffer(new Response("hello"), { maxBytes: "5" });
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString("utf8")).toBe("hello");
  });
});
