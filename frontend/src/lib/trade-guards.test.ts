import { describe, expect, it } from "vitest";

import { fallbackStrategy } from "./order-strategy";
import { icebergSentSize, type RangeIcebergInput } from "./range-iceberg";
import { applyClose, applyReducing, defaultKeepPosition, resultingSize, rowsForPane, sideOptions } from "./trade-guards";

const input = (patch: Partial<RangeIcebergInput> = {}): RangeIcebergInput => ({
  side: "BUY",
  mode: "RANGE",
  totalAmount: 60770,
  sizeUnit: "BASE",
  priceLow: 0.07,
  priceHigh: 0.09,
  limitPrice: 0,
  iceberg: true,
  visibleCount: 2,
  levels: 10,
  duration: "",
  scheduleSlices: 0,
  scheduleInterval: "",
  catchUp: "CARRY",
  capBehavior: "REST_AT_CAP",
  leverage: 2,
  marginMode: "ISOLATED",
  reduceOnly: false,
  distribution: "LINEAR",
  weight: 0,
  postOnly: false,
  sliceAmount: 0,
  sizeJitterPct: 0,
  priceJitterPct: 0,
  timingJitterPct: 0,
  minOrderInterval: 0.6,
  expirySeconds: 0,
  maxSlippage: 0,
  randomSeed: "",
  ...patch,
});

describe("review guards", () => {
  it("fits every iceberg child to the step", () => {
    const sent = icebergSentSize(input(), { minOrderSize: 10, increment: 10 }, 0.08, false);
    expect(sent.error).toBeNull();
    expect(sent.perSlice % 10).toBe(0);
    expect(sent.total).toBe(sent.perSlice * sent.sliceCount);
    expect(sent.total).toBeLessThanOrEqual(60770);
  });

  it("caps the total before flooring each child", () => {
    const sent = icebergSentSize(
      input({ totalAmount: 100000 }),
      { minOrderSize: 10, increment: 10 },
      0.08,
      false,
      60770,
    );
    expect(sent.error).toBeNull();
    expect(sent.perSlice).toBe(6070);
    expect(sent.total).toBe(60700);
    expect(sent.sliceCount).toBe(10);
  });

  it("blocks contracts until they are confirmed", () => {
    const blocked = icebergSentSize(input({ sizeUnit: "CONTRACTS", totalAmount: 15 }), null, 0, false);
    expect(blocked.error).toMatch(/contracts/i);
    const sent = icebergSentSize(input({ sizeUnit: "CONTRACTS", totalAmount: 15 }), null, 0, true);
    expect(sent.error).toBeNull();
    expect(sent.perSlice).toBe(1);
    expect(sent.total).toBe(sent.perSlice * sent.sliceCount);
  });

  it("falls back to limit and never rewrites a resting order to market", () => {
    expect(fallbackStrategy("LIMIT_MAKER", ["MARKET", "LIMIT"])).toBe("LIMIT");
    expect(fallbackStrategy("LIMIT", ["MARKET"])).toBeNull();
    expect(fallbackStrategy("MARKET", ["LIMIT"])).toBe("LIMIT");
  });

  it("maps close to reduce-only and caps the size", () => {
    const config: Record<string, unknown> = { side: 1, amount: 100000, position_action: "OPEN" };
    const error = applyClose(
      config,
      { amount: 60770, side: "LONG", leverage: 2, marginMode: "ISOLATED" },
      "CLOSE",
    );
    expect(error).toBeNull();
    expect(config.reduce_only).toBe(true);
    expect(config.side).toBe(2);
    expect(config.amount).toBe(60770);
  });

  it("caps a one-way sell and subtracts it from the long", () => {
    const book = { amount: 60770, side: "LONG" as const, leverage: 2, marginMode: null };
    const config: Record<string, unknown> = { side: 2, amount: 100000 };
    expect(applyReducing(config, book, "OPEN", "ONEWAY")).toBeNull();
    expect(config.reduce_only).toBe(true);
    expect(config.amount).toBe(60770);
    expect(resultingSize(60770, 1000, true)).toBe(59770);
    expect(resultingSize(60770, 1000, false)).toBe(61770);
  });

  it("names a one-way sell and keeps a venue position by default", () => {
    const labels = sideOptions("ONEWAY", { amount: 60770, side: "LONG", leverage: 2, marginMode: null });
    expect(labels[1].label).toMatch(/reduces/);
    expect(defaultKeepPosition(60770)).toBe(true);
    expect(defaultKeepPosition(0)).toBe(false);
  });

  it("shows the exchange amount and a tracked twin only when they differ", () => {
    const venue = [{ source: "venue", connector: "mexc_perpetual", trading_pair: "AIOT_USDT", side: "LONG", amount: 60770 }];
    const same = rowsForPane(
      [{ source: "executor", connector: "mexc_perpetual", trading_pair: "AIOT-USDT", side: "BUY", amount: 60770 }],
      venue,
    );
    expect(same).toHaveLength(1);
    expect(same[0].source).toBe("venue");
    const both = rowsForPane(
      [{ source: "executor", connector: "mexc_perpetual", trading_pair: "AIOT-USDT", side: "LONG", amount: 10 }],
      venue,
    );
    expect(both.map((row) => row.source)).toEqual(["venue", "executor"]);
  });
});
