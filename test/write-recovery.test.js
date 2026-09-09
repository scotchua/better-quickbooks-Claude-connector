import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { qboRequest, qboUpload } from "../src/qbo.js";
import { listUnresolvedWrites, toolContext, writeRecoveryFilePath } from "../src/audit.js";

const SLUG = "write-recovery-test";
const TOKEN_FILE = path.join(process.env.QBO_TOKENS_DIR, `tokens.${SLUG}.json`);
const ENV_KEYS = ["QBO_AUDIT", "QBO_AUDIT_DIR", "QBO_POLICY_FILE", "QBO_TOKEN_ENCRYPTION"];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

async function recoveryRecords() {
  return (await readFile(writeRecoveryFilePath(), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

function okResponse(id = "501") {
  return new Response(JSON.stringify({ Invoice: { Id: id, DocNumber: "INV-1", TotalAmt: 125 } }), {
    status: 200,
    headers: { "content-type": "application/json", intuit_tid: `tid-${id}` },
  });
}

describe("qboRequest durable write recovery", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "qbo-write-recovery-"));
    process.env.QBO_AUDIT_DIR = dir;
    process.env.QBO_AUDIT = "off";
    process.env.QBO_POLICY_FILE = path.join(dir, "missing-policy.json");
    process.env.QBO_TOKEN_ENCRYPTION = "off";
    const tokenStage = `${TOKEN_FILE}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tokenStage, JSON.stringify({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_at: Date.now() + 3_600_000,
      refresh_expires_at: Date.now() + 86_400_000,
      realmId: "123456789012345",
      environment: "sandbox",
    }), { mode: 0o600 });
    await rename(tokenStage, TOKEN_FILE);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(TOKEN_FILE, { force: true });
    await rm(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
  });

  it("fsyncs the complete intent before fetch, then records the response outcome", async () => {
    const body = { CustomerRef: { value: "7" }, Line: [{ Amount: 125 }] };
    const fetchMock = vi.fn(async (url, init) => {
      const beforeSend = await recoveryRecords();
      expect(beforeSend).toHaveLength(1);
      expect(beforeSend[0]).toMatchObject({
        kind: "api_write_intent",
        company: SLUG,
        realmId: "123456789012345",
        environment: "sandbox",
        method: "POST",
      });
      expect(beforeSend[0].body_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(beforeSend[0].path).toContain("/invoice?include=full&minorversion=75&requestid=");
      expect(String(url)).toContain(beforeSend[0].path);
      expect(init.body).toBe(JSON.stringify(body));
      return okResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(qboRequest("/invoice?include=full", {
      method: "POST", body, company: SLUG,
    })).resolves.toMatchObject({ Invoice: { Id: "501" } });

    const records = await recoveryRecords();
    expect(records.map((r) => r.kind)).toEqual(["api_write_intent", "api_write_outcome"]);
    expect(records[1]).toMatchObject({
      request_id: records[0].request_id,
      path: records[0].path,
      body_sha256: records[0].body_sha256,
      outcome: "response",
      status: 200,
      ok: true,
      intuit_tid: "tid-501",
      entity: "Invoice",
      entityId: "501",
    });
  });

  it("makes a concurrent replay wait for the original request's definitive outcome", async () => {
    const body = { CustomerRef: { value: "7" }, Line: [{ Amount: 125 }] };
    let signalFetchEntered;
    const fetchEntered = new Promise((resolve) => { signalFetchEntered = resolve; });
    let allowResponse;
    const canRespond = new Promise((resolve) => { allowResponse = resolve; });
    const fetchMock = vi.fn(async () => {
      signalFetchEntered();
      await canRespond;
      return okResponse("601");
    });
    vi.stubGlobal("fetch", fetchMock);

    const original = qboRequest("/invoice", { method: "POST", body, company: SLUG });
    await fetchEntered;
    const requestId = (await recoveryRecords())[0].request_id;
    let replaySettled = false;
    const replay = qboRequest("/invoice", {
      method: "POST",
      body,
      company: SLUG,
      requestId,
    }).then((value) => ({ value }), (error) => ({ error }))
      .finally(() => { replaySettled = true; });

    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(replaySettled).toBe(false);
    } finally {
      allowResponse();
    }

    await expect(original).resolves.toMatchObject({ Invoice: { Id: "601" } });
    const replayResult = await replay;
    expect(replayResult.value).toBeUndefined();
    expect(replayResult.error?.message).toMatch(/definitive durable outcome.*replaying a resolved id is refused/is);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await recoveryRecords()).map((record) => record.kind))
      .toEqual(["api_write_intent", "api_write_outcome"]);
  }, 15_000);

  it("refuses an unverifiable request_id before calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(qboRequest("/invoice", {
      method: "POST",
      body: { CustomerRef: { value: "7" } },
      company: SLUG,
      requestId: "not-in-the-ledger",
    })).rejects.toThrow(/no durable write intent/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "/invoice#hide-managed-suffix",
    "/invoice?requestid=caller-chosen",
    "/invoice?minorversion=1",
  ])("rejects raw path control of the managed request envelope: %s", async (unsafePath) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(qboRequest(unsafePath, { company: SLUG })).rejects.toThrow(/fragments|reserved/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows one recent unresolved envelope replay and refuses changed body or path", async () => {
    const body = { CustomerRef: { value: "7" }, Line: [{ Amount: 125 }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "upstream response lost" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }))
      .mockImplementation(async () => okResponse(String(500 + fetchMock.mock.calls.length)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(qboRequest("/invoice?include=full", { method: "POST", body, company: SLUG }))
      .rejects.toThrow(/503.*request_id/is);
    const requestId = (await recoveryRecords())[0].request_id;

    await expect(qboRequest("/invoice?include=full", {
      method: "POST", body, company: SLUG, requestId,
    })).resolves.toHaveProperty("Invoice");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(qboRequest("/invoice?include=full", {
      method: "POST", body: { ...body, PrivateNote: "changed" }, company: SLUG, requestId,
    })).rejects.toThrow(/body_sha256/);
    await expect(qboRequest("/bill?include=full", {
      method: "POST", body, company: SLUG, requestId,
    })).rejects.toThrow(/path/);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const intents = (await recoveryRecords()).filter((r) => r.kind === "api_write_intent");
    expect(intents).toHaveLength(2);
    expect(intents[1]).toMatchObject({ replay: true, original_intent_ts: intents[0].ts });
  });

  it("does not send when the intent cannot be persisted", async () => {
    const blocker = path.join(dir, "not-a-directory");
    await writeFile(blocker, "x");
    process.env.QBO_AUDIT_DIR = path.join(blocker, "nested");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(qboRequest("/invoice", {
      method: "POST", body: { CustomerRef: { value: "7" } }, company: SLUG,
    })).rejects.toThrow(/NOT sent/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a raw posting POST with no body under min_txn_date before fetch", async () => {
    await writeFile(process.env.QBO_POLICY_FILE, JSON.stringify({
      defaults: { min_txn_date: "2026-01-01" },
      companies: {},
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(qboRequest("/invoice", {
      method: "POST",
      company: SLUG,
    })).rejects.toThrow(/omitted TxnDate.*date floor 2026-01-01.*Supply TxnDate explicitly/is);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records an unknown transport outcome and exposes the recoverable id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket reset"); }));

    let error;
    try {
      await qboRequest("/invoice", {
        method: "POST", body: { CustomerRef: { value: "7" } }, company: SLUG,
      });
    } catch (e) {
      error = e;
    }
    const records = await recoveryRecords();
    expect(records.map((r) => r.kind)).toEqual(["api_write_intent", "api_write_outcome"]);
    expect(records[1]).toMatchObject({
      request_id: records[0].request_id,
      outcome: "transport_error",
      status: null,
      ok: null,
      error: "socket reset",
    });
    expect(error.message).toContain(`request_id ${records[0].request_id}`);
    expect(error.message).toMatch(/may or may not have been applied/);
  });

  it("keeps HTTP 408 writes and uploads unresolved with exact-replay guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "request timeout" }), {
      status: 408,
      headers: { "content-type": "application/json" },
    })));

    await expect(qboRequest("/invoice", {
      method: "POST", body: { CustomerRef: { value: "7" } }, company: SLUG,
    })).rejects.toThrow(/408.*request_id/is);

    const form = new FormData();
    form.append("file_metadata_01", new Blob(["{}"], { type: "application/json" }), "metadata.json");
    form.append("file_content_01", new Blob(["receipt"], { type: "text/plain" }), "receipt.txt");
    await expect(qboUpload(form, { company: SLUG }))
      .rejects.toThrow(/408.*request_id.*re-send.*same request_id/is);

    const unresolved = await listUnresolvedWrites();
    expect(unresolved).toHaveLength(2);
    expect(unresolved.every((row) => row.status === 408 && row.replay_eligible)).toBe(true);
  });

  it("directs composite workflows to reconcile instead of promising an unsafe blanket replay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket reset"); }));

    await expect(toolContext.run({
      tool: "create_journal_entry_multi",
      recoverySupported: false,
      recoveryRequestId: null,
      recoveryClaimed: false,
    }, () => qboRequest("/journalentry", {
      method: "POST", body: { Line: [] }, company: SLUG,
    }))).rejects.toThrow(/composite workflow.*does not accept.*generic request_id.*dedicated single-record tool/is);
  });

  it("binds multipart uploads to their ordered fields, metadata, and bytes", async () => {
    const makeBody = (contents = "receipt bytes") => {
      const form = new FormData();
      form.append(
        "file_metadata_01",
        new Blob([JSON.stringify({ FileName: "receipt.txt", ContentType: "text/plain" })], {
          type: "application/json",
        }),
        "metadata.json"
      );
      form.append("file_content_01", new Blob([contents], { type: "text/plain" }), "receipt.txt");
      return form;
    };
    const fetchMock = vi.fn(async (url) => {
      const beforeSend = await recoveryRecords();
      const latest = beforeSend.at(-1);
      expect(latest).toMatchObject({
        kind: "api_write_intent",
        method: "POST",
        company: SLUG,
      });
      expect(latest.path).toMatch(/^\/upload\?minorversion=75&requestid=/);
      expect(latest.body_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(String(url)).toContain(latest.path);
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify({ error: "upstream response lost" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ AttachableResponse: [{ Attachable: { Id: "88" } }] }), {
        status: 200,
        headers: { intuit_tid: "tid-upload" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(qboUpload(makeBody(), { company: SLUG })).rejects.toThrow(/503.*request_id/is);
    const first = (await recoveryRecords()).find((r) => r.kind === "api_write_intent");

    await expect(qboUpload(makeBody(), { company: SLUG, requestId: first.request_id }))
      .resolves.toHaveProperty("AttachableResponse");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(qboUpload(makeBody("different receipt bytes"), {
      company: SLUG,
      requestId: first.request_id,
    })).rejects.toThrow(/body_sha256/);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const records = await recoveryRecords();
    expect(records.filter((r) => r.kind === "api_write_intent")).toHaveLength(2);
    expect(records.filter((r) => r.kind === "api_write_outcome")).toHaveLength(2);
  });

  it("makes a concurrent upload replay wait for the original upload outcome", async () => {
    const makeBody = () => {
      const form = new FormData();
      form.append(
        "file_metadata_01",
        new Blob([JSON.stringify({ FileName: "receipt.txt", ContentType: "text/plain" })], {
          type: "application/json",
        }),
        "metadata.json"
      );
      form.append("file_content_01", new Blob(["receipt"], { type: "text/plain" }), "receipt.txt");
      return form;
    };
    let signalFetchEntered;
    const fetchEntered = new Promise((resolve) => { signalFetchEntered = resolve; });
    let allowResponse;
    const canRespond = new Promise((resolve) => { allowResponse = resolve; });
    const fetchMock = vi.fn(async () => {
      signalFetchEntered();
      await canRespond;
      return new Response(JSON.stringify({ AttachableResponse: [{ Attachable: { Id: "98" } }] }), {
        status: 200,
        headers: { "content-type": "application/json", intuit_tid: "tid-upload-lock" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const original = qboUpload(makeBody(), { company: SLUG });
    await fetchEntered;
    const requestId = (await recoveryRecords())[0].request_id;
    let replaySettled = false;
    const replay = qboUpload(makeBody(), { company: SLUG, requestId })
      .then((value) => ({ value }), (error) => ({ error }))
      .finally(() => { replaySettled = true; });

    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(replaySettled).toBe(false);
    } finally {
      allowResponse();
    }

    await expect(original).resolves.toHaveProperty("AttachableResponse");
    const replayResult = await replay;
    expect(replayResult.value).toBeUndefined();
    expect(replayResult.error?.message).toMatch(/definitive durable outcome.*replaying a resolved id is refused/is);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await recoveryRecords()).map((record) => record.kind))
      .toEqual(["api_write_intent", "api_write_outcome"]);
  }, 15_000);
});
