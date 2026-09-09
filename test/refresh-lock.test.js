// withRefreshLock serializes the read-decide-exchange-write sequence around a
// token refresh ACROSS PROCESSES. Intuit can replace refresh-token state and
// warns that overlapping refresh attempts may invalidate the grant, so two
// refreshers can leave a company offline until someone re-authorizes. The
// in-process Map in qbo.js cannot see another process; this lock directory can.
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, unlink, utimes, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { withRefreshLock } from "../src/qbo.js";

const lockFor = (slug) => path.join(process.env.QBO_TOKENS_DIR, `.refresh-${slug}.lock`);

async function cleanup(slug) {
  await rm(lockFor(slug), { recursive: true, force: true });
}

async function createOwnerLock(lockPath, {
  pid = process.pid,
  ownerHostname = hostname(),
  token = randomUUID(),
} = {}) {
  await mkdir(lockPath, { mode: 0o700 });
  const marker = path.join(lockPath, `owner-${token}.json`);
  await writeFile(marker, JSON.stringify({
    version: 1,
    pid,
    hostname: ownerHostname,
    token,
    created_at: new Date().toISOString(),
  }));
  return marker;
}

afterEach(async () => {
  for (const s of ["locktest", "locktest-stale", "locktest-killed", "locktest-throw", "locktest-busy", "locktest-bad", "locktest-swapped"]) await cleanup(s);
});

describe("withRefreshLock", () => {
  it("runs the critical section and releases the lock", async () => {
    const result = await withRefreshLock("locktest", async () => {
      // The lock exists while the section runs.
      await expect(stat(lockFor("locktest"))).resolves.toBeTruthy();
      return "done";
    });
    expect(result).toBe("done");
    await expect(stat(lockFor("locktest"))).rejects.toThrow();
  });

  it("serializes overlapping callers instead of interleaving them", async () => {
    const order = [];
    const section = (id) => async () => {
      order.push(`enter${id}`);
      await new Promise((r) => setTimeout(r, 60));
      order.push(`exit${id}`);
    };
    await Promise.all([
      withRefreshLock("locktest", section(1)),
      withRefreshLock("locktest", section(2)),
    ]);
    // Whoever went first must have finished before the other started. An
    // interleaved order (enter1, enter2, ...) is the bug this prevents.
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(order[0].replace("enter", "exit"));
    expect(order[3]).toBe(order[2].replace("enter", "exit"));
  });

  it("releases the lock even when the critical section throws", async () => {
    await expect(
      withRefreshLock("locktest-throw", async () => { throw new Error("refresh blew up"); })
    ).rejects.toThrow(/refresh blew up/);
    await expect(stat(lockFor("locktest-throw"))).rejects.toThrow();
  });

  it("reclaims an old directory abandoned before its owner marker was written", async () => {
    // A process can die after atomic mkdir but before its durable marker. The
    // resulting empty directory is reclaimed only after the stale threshold.
    const stale = lockFor("locktest-stale");
    await mkdir(stale);
    const old = new Date(Date.now() - 6 * 60_000);
    await utimes(stale, old, old);

    await expect(withRefreshLock("locktest-stale", async () => "recovered")).resolves.toBe("recovered");
  });

  it("reclaims a current owner-aware lock after its real process is killed", async () => {
    const slug = "locktest-killed";
    const qboModule = new URL("../src/qbo.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { withRefreshLock } from ${JSON.stringify(qboModule)};
      await withRefreshLock(${JSON.stringify(slug)}, async () => {
        process.stdout.write("LOCKED\\n");
        setInterval(() => {}, 1_000);
        await new Promise(() => {});
      });
    `], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    let stdout = "";
    const locked = new Promise((resolve) => {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("LOCKED\n")) resolve();
      });
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await Promise.race([
      locked,
      new Promise((_, reject) => setTimeout(() => reject(new Error("child did not acquire lock")), 5_000)),
    ]);
    await expect(stat(lockFor(slug))).resolves.toBeTruthy();

    child.kill();
    const exit = await closed;
    expect(exit.signal || exit.code !== 0).toBeTruthy();
    // The owner-marker directory is intentionally left by the killed process.
    // The next owner verifies that PID is gone and reclaims without an age delay.
    await expect(stat(lockFor(slug))).resolves.toBeTruthy();
    await expect(withRefreshLock(slug, async () => "recovered")).resolves.toBe("recovered");
    await expect(stat(lockFor(slug))).rejects.toThrow();
  }, 15_000);

  it("does not steal an old lock whose owner is still alive", async () => {
    // A slow Intuit response can outlive an age threshold. Process liveness,
    // not age alone, decides whether the waiter may reclaim the lock.
    const held = lockFor("locktest-busy");
    const marker = await createOwnerLock(held);
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(marker, old, old);

    let ran = false;
    const waiter = withRefreshLock("locktest-busy", async () => { ran = true; return "went"; });
    await new Promise((r) => setTimeout(r, 250));
    expect(ran).toBe(false); // still blocked

    await rm(held, { recursive: true }); // external holder finishes
    await expect(waiter).resolves.toBe("went");
    expect(ran).toBe(true);
  });

  it("fails closed with migration guidance for a legacy file lock", async () => {
    const legacy = lockFor("locktest-bad");
    await writeFile(legacy, "999999");
    let ran = false;
    await expect(
      withRefreshLock("locktest-bad", async () => { ran = true; })
    ).rejects.toThrow(/legacy or malformed file.*Refusing.*manually/is);
    expect(ran).toBe(false);
    expect((await readFile(legacy, "utf8"))).toBe("999999");
  });

  it("refuses to remove a lock that changed owners before release", async () => {
    const held = lockFor("locktest-swapped");
    await expect(withRefreshLock("locktest-swapped", async () => {
      const [ownMarker] = await readdir(held);
      await unlink(path.join(held, ownMarker));
      const replacementToken = randomUUID();
      await writeFile(path.join(held, `owner-${replacementToken}.json`), JSON.stringify({
        version: 1,
        pid: process.pid,
        hostname: "replacement-owner",
        token: replacementToken,
        created_at: new Date().toISOString(),
      }));
      return "operation-finished";
    })).rejects.toThrow(/unique owner marker disappeared.*replacement path will not be removed/is);

    // The replacement owner's lock remains intact; the old owner did not
    // unlink a directory entry it no longer owned.
    await expect(stat(held)).resolves.toBeTruthy();
    expect(await readdir(held)).toHaveLength(1);
  });
});
