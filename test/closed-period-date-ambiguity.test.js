import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const qbo = vi.hoisted(() => ({
  qboQuery: vi.fn(),
  qboRequest: vi.fn(async () => ({
    Preferences: { AccountingInfoPrefs: { BookCloseDate: "2026-01-31" } },
  })),
}));

vi.mock("../src/qbo.js", () => qbo);

import { closedPeriodWarnings } from "../src/entities.js";

beforeEach(() => {
  qbo.qboRequest.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("closed-period checks for omitted transaction dates", () => {
  it("warns without inventing a local UTC date in warn mode", async () => {
    vi.stubEnv("QBO_CLOSED_PERIOD", "warn");
    await expect(closedPeriodWarnings("date-ambiguity-warn", [undefined])).resolves.toEqual([
      expect.stringMatching(/no valid explicit TxnDate.*server time.*timezone.*Supply TxnDate explicitly/is),
    ]);
  });

  it("fails closed when block mode cannot verify the effective QBO date", async () => {
    vi.stubEnv("QBO_CLOSED_PERIOD", "block");
    await expect(closedPeriodWarnings("date-ambiguity-block", [undefined]))
      .rejects.toThrow(/no valid explicit TxnDate.*QBO_CLOSED_PERIOD=block/is);
  });

  it("continues to permit an explicit date after the book close", async () => {
    vi.stubEnv("QBO_CLOSED_PERIOD", "block");
    await expect(closedPeriodWarnings("date-ambiguity-open", ["2026-02-01"]))
      .resolves.toEqual([]);
  });

  it("rejects an invalid closed-period mode instead of silently weakening it", async () => {
    vi.stubEnv("QBO_CLOSED_PERIOD", "blok");
    await expect(closedPeriodWarnings("date-ambiguity-bad-mode", ["2026-02-01"]))
      .rejects.toThrow(/must be warn, block, or off.*Refusing to guess/is);
    expect(qbo.qboRequest).not.toHaveBeenCalled();
  });

  it("fails closed when QuickBooks returns a malformed BookCloseDate", async () => {
    vi.stubEnv("QBO_CLOSED_PERIOD", "warn");
    qbo.qboRequest.mockResolvedValueOnce({
      Preferences: { AccountingInfoPrefs: { BookCloseDate: "2026-02-30" } },
    });
    await expect(closedPeriodWarnings("date-ambiguity-malformed-close", ["2026-03-01"]))
      .rejects.toThrow(/invalid BookCloseDate.*will not treat malformed accounting preferences as open books/is);
  });

  it("warns when Preferences cannot be read and no verified close date is cached", async () => {
    vi.stubEnv("QBO_CLOSED_PERIOD", "warn");
    qbo.qboRequest.mockRejectedValueOnce(new Error("preferences unavailable"));
    await expect(closedPeriodWarnings("date-ambiguity-preferences-outage", ["2026-03-01"]))
      .resolves.toEqual([
        expect.stringMatching(/Could not verify.*preferences unavailable.*permits the write.*could not determine.*closed books/is),
      ]);
  });
});
