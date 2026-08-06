// withRefreshLock serializes the read-decide-exchange-write sequence around a
// token refresh ACROSS PROCESSES. Intuit invalidates the old refresh token on
// every rotation, so two overlapping refreshes can leave a company offline
// until someone re-authorizes. The in-process Map in qbo.js cannot see another
// process; this lock file is the part that can.
import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink, utimes, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withRefreshLock } from "../src/qbo.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockFor = (slug) => path.join(ROOT, `.refresh-${slug}.lock`);

async function cleanup(slug) {
  try { await unlink(lockFor(slug)); } catch { /* already gone */ }
}

afterEach(async () => {
  for (const s of ["locktest", "locktest-stale", "locktest-throw", "locktest-busy"]) await cleanup(s);
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

  it("reclaims a lock abandoned by a process that died mid-refresh", async () => {
    // A lock file with nobody behind it must not wedge the company forever.
    const stale = lockFor("locktest-stale");
    await writeFile(stale, "999999");
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(stale, old, old);

    await expect(withRefreshLock("locktest-stale", async () => "recovered")).resolves.toBe("recovered");
  });

  it("does not steal a lock that is still fresh", async () => {
    // Held by a live holder: the waiter must wait, not barge in.
    const held = lockFor("locktest-busy");
    await writeFile(held, "12345");

    let ran = false;
    const waiter = withRefreshLock("locktest-busy", async () => { ran = true; return "went"; });
    await new Promise((r) => setTimeout(r, 250));
    expect(ran).toBe(false); // still blocked

    await unlink(held); // holder finishes
    await expect(waiter).resolves.toBe("went");
    expect(ran).toBe(true);
  });
});
