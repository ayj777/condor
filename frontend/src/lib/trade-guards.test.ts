import { describe, expect, it } from "vitest";

import { fallbackStrategy } from "./order-strategy";
import { icebergSentSize, type RangeIcebergInput } from "./range-iceberg";
import { quoteTogglePrice } from "./order-size";
import { applyClose, applyHedge, applyReducing, canonicalPositionMode, claimInflight, defaultKeepPosition, executorBookSide, icebergCreateHeld, isOneWay, marginForOpen, MARGIN_CHOOSE, orderCap, ordersBlockCreate, positionModeBlocksCreate, positionModeLabel, resultingSize, rowsForPane, sideHasOpenPosition, sideOptions } from "./trade-guards";

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
  scheduleInterval: "",
  scheduleStart: "SUBMIT",
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
  expiry: "",
  expirySeconds: 0,
  maxSlippage: 0,
  randomSeed: "",
  ...patch,
});

describe("review guards", () => {
  it("sends a base range total and lets the ladder split it", () => {
    const sent = icebergSentSize(input(), { minOrderSize: 10, increment: 10 }, 0.08, false);
    expect(sent.error).toBeNull();
    expect(sent.sizeUnit).toBe("BASE");
    expect(sent.total).toBe(60770);
    expect(sent.rungs).toBeGreaterThan(0);
    expect(sent.baseTotal).toBeLessThanOrEqual(60770);
  });

  it("caps a base range at the open size without writing a slice", () => {
    const sent = icebergSentSize(
      input({ totalAmount: 100000 }),
      { minOrderSize: 10, increment: 10 },
      0.08,
      false,
      60770,
    );
    expect(sent.error).toBeNull();
    expect(sent.total).toBe(60770);
    expect(sent.sizeUnit).toBe("BASE");
  });

  it("blocks contracts until they are confirmed", () => {
    const blocked = icebergSentSize(input({ sizeUnit: "CONTRACTS", totalAmount: 15 }), null, 0, false);
    expect(blocked.error).toMatch(/contracts/i);
    const unknown = icebergSentSize(
      input({ sizeUnit: "CONTRACTS", totalAmount: 15 }),
      null,
      0,
      true,
    );
    expect(unknown.error).toMatch(/contract size/i);
    const sent = icebergSentSize(
      input({ sizeUnit: "CONTRACTS", totalAmount: 15 }),
      { minOrderSize: 1, increment: 1, contractSize: 10 },
      0,
      true,
    );
    expect(sent.error).toBeNull();
    expect(sent.sizeUnit).toBe("CONTRACTS");
    expect(sent.total).toBe(15);
  });

  it("caps contracts by the open base size", () => {
    const sent = icebergSentSize(
      input({ sizeUnit: "CONTRACTS", totalAmount: 7000, levels: 10 }),
      { minOrderSize: 1, increment: 1, contractSize: 10 },
      0,
      true,
      60770,
    );
    expect(sent.error).toBeNull();
    expect(sent.total).toBe(6077);
    expect(sent.total * 10).toBeLessThanOrEqual(60770);
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

  it("opens a hedge short without touching the long, and closes the long explicitly", () => {
    const books = {
      long: { amount: 60770, side: "LONG" as const, leverage: 2, marginMode: null },
      short: null,
    };
    expect(canonicalPositionMode(1)).toBe("HEDGE");
    expect(canonicalPositionMode("1")).toBe("HEDGE");
    expect(canonicalPositionMode(2)).toBe("ONEWAY");
    expect(canonicalPositionMode("positionMode.2")).toBe("");
    expect(positionModeLabel("1")).toBe("Hedge");
    expect(positionModeLabel(1)).toBe("Hedge");
    expect(isOneWay("1")).toBe(false);
    expect(isOneWay("2")).toBe(true);
    expect(sideOptions("HEDGE", books.long, "OPEN").map((item) => item.label)).toEqual([
      "Open long",
      "Open short",
    ]);
    expect(sideOptions("1", books.long, "CLOSE").map((item) => item.label)).toEqual([
      "Close long",
      "Close short",
    ]);

    const opened: Record<string, unknown> = { side: 2, amount: 1000, total_amount: 1000 };
    expect(applyHedge(opened, books, "OPEN", 2)).toBeNull();
    expect(opened.reduce_only).toBe(false);
    expect(opened.position_action).toBe("OPEN");
    expect(opened.position_side).toBe("SHORT");
    expect(opened.amount).toBe(1000);
    expect(orderCap("HEDGE", books, books.long, "OPEN", 2)).toBe(0);

    const closed: Record<string, unknown> = { side: 1, amount: 100000, total_amount: 100000 };
    expect(applyHedge(closed, books, "CLOSE", 1)).toBeNull();
    expect(closed.reduce_only).toBe(true);
    expect(closed.position_action).toBe("CLOSE");
    expect(closed.position_side).toBe("LONG");
    expect(closed.side).toBe(2);
    expect(closed.amount).toBe(60770);
    expect(closed.total_amount).toBe(60770);
    expect(orderCap("HEDGE", books, books.long, "CLOSE", 1)).toBe(60770);
    const iceberg: Record<string, unknown> = { side: "BUY", total_amount: 80000 };
    expect(applyHedge(iceberg, books, "CLOSE", 1)).toBeNull();
    expect(iceberg.side).toBe("SELL");
    expect(iceberg.position_side).toBe("LONG");
    expect(iceberg.reduce_only).toBe(true);
    expect(iceberg.total_amount).toBe(60770);
    expect(applyHedge({ side: "SELL", total_amount: 50 }, books, "CLOSE", 2)).toMatch(/short/i);
  });

  it("stops a hedge short against its own side", () => {
    expect(executorBookSide({ side: "SELL", config: { position_action: "OPEN" } })).toBe("SHORT");
    expect(executorBookSide({ config: { side: 2, position_action: "CLOSE" } })).toBe("LONG");
    expect(executorBookSide({ config: { position_side: "LONG", side: "SELL" } })).toBe("LONG");
  });

  it("names a one-way sell and keeps a venue position by default", () => {
    const labels = sideOptions("ONEWAY", { amount: 60770, side: "LONG", leverage: 2, marginMode: null });
    expect(labels[1].label).toMatch(/reduces/);
    expect(defaultKeepPosition(60770)).toBe(true);
    expect(defaultKeepPosition(0)).toBe(false);
  });

  it("sends the typed base total and reports the ladder after the contract step", () => {
    const sent = icebergSentSize(
      input({ totalAmount: 25, levels: 1, duration: "", scheduleInterval: "" }),
      { minOrderSize: 10, increment: 1, contractSize: 10 },
      0,
      false,
    );
    expect(sent.error).toBeNull();
    expect(sent.sizeUnit).toBe("BASE");
    expect(sent.total).toBe(25);
    expect(sent.baseTotal).toBe(20);
  });

  it("sends a quote range as quote and previews the ladder base", () => {
    const sent = icebergSentSize(
      input({ sizeUnit: "QUOTE", totalAmount: 80, levels: 2, priceLow: 0.08, priceHigh: 0.08 }),
      { minOrderSize: 10, increment: 10 },
      0.08,
      false,
    );
    expect(sent.error).toBeNull();
    expect(sent.sizeUnit).toBe("QUOTE");
    expect(sent.total).toBe(80);
    expect(sent.baseTotal).toBe(1000);
  });

  it("does not cap a quote close by the base position size", () => {
    const config: Record<string, unknown> = {
      side: "SELL",
      total_amount: 100,
      size_unit: "QUOTE",
      position_action: "OPEN",
    };
    expect(applyClose(
      config,
      { amount: 10, side: "LONG", leverage: 2, marginMode: "ISOLATED" },
      "CLOSE",
    )).toBeNull();
    expect(config.total_amount).toBe(100);
    expect(config.reduce_only).toBe(true);

    const hedge: Record<string, unknown> = {
      side: "BUY",
      total_amount: 100,
      size_unit: "QUOTE",
    };
    expect(applyHedge(
      hedge,
      {
        long: { amount: 10, side: "LONG", leverage: 2, marginMode: null },
        short: null,
      },
      "CLOSE",
      1,
    )).toBeNull();
    expect(hedge.total_amount).toBe(100);
    expect(hedge.reduce_only).toBe(true);
  });

  it("does not treat a hedge short as the same book as the long", () => {
    const rows = rowsForPane(
      [{ connector: "mexc_perpetual", trading_pair: "AIOT-USDT", position_side: "SHORT", amount: 10, source: "executor" }],
      [{ connector: "mexc_perpetual", trading_pair: "AIOT-USDT", position_side: "LONG", amount: 60770, source: "venue" }],
    );
    expect(rows.map((row) => row.position_side)).toEqual(["LONG", "SHORT"]);
  });

  it("blocks create only for an order book order or iceberg", () => {
    expect(ordersBlockCreate("order", true, true)).toBe(true);
    expect(ordersBlockCreate("iceberg", true, true)).toBe(true);
    expect(ordersBlockCreate("grid", true, true)).toBe(false);
    expect(ordersBlockCreate("lp", true, true)).toBe(false);
    expect(ordersBlockCreate("order", false, true)).toBe(false);
  });

  it("sends the displayed margin when that side has no position", () => {
    const flat = {
      isSpot: false,
      opening: true,
      explicit: false,
      displayed: "ISOLATED",
      positionsKnown: true,
      sideHasPosition: false,
    };
    expect(marginForOpen(flat)).toEqual({ send: true, mode: "ISOLATED" });
    expect(marginForOpen({ ...flat, displayed: "CROSS" })).toEqual({ send: true, mode: "CROSS" });
    expect(marginForOpen({ ...flat, sideHasPosition: true })).toEqual({ send: false });
    expect(marginForOpen({ ...flat, sideHasPosition: true, explicit: true, displayed: "CROSS" })).toEqual({
      send: true,
      mode: "CROSS",
    });
    expect(marginForOpen({ ...flat, positionsKnown: false })).toEqual({ block: MARGIN_CHOOSE });
    expect(marginForOpen({ ...flat, sideHasPosition: null })).toEqual({ block: MARGIN_CHOOSE });
    expect(marginForOpen({ ...flat, opening: false })).toEqual({ send: false });
    const long = { amount: 60770, side: "LONG" as const, leverage: 2, marginMode: "ISOLATED" };
    expect(sideHasOpenPosition("HEDGE", { long, short: null }, long, 1)).toBe(true);
    expect(sideHasOpenPosition("HEDGE", { long, short: null }, long, 2)).toBe(false);
  });

  it("holds a perp order until position mode is read and holds iceberg while margin would default", () => {
    expect(positionModeBlocksCreate(false, "order", false)).toBe(true);
    expect(positionModeBlocksCreate(false, "iceberg", false)).toBe(true);
    expect(positionModeBlocksCreate(false, "order", true)).toBe(false);
    expect(positionModeBlocksCreate(false, "grid", false)).toBe(false);
    expect(positionModeBlocksCreate(true, "order", false)).toBe(false);
    expect(icebergCreateHeld(false, "iceberg", "LIMIT")).toBe(true);
    expect(icebergCreateHeld(false, "order", "RANGE_ICEBERG")).toBe(true);
    expect(icebergCreateHeld(true, "iceberg", "RANGE_ICEBERG")).toBe(false);
    expect(icebergCreateHeld(false, "order", "LIMIT")).toBe(false);
  });

  it("converts a quote amount at the limit price", () => {
    expect(quoteTogglePrice(0.05, 0.08, true)).toBe(0.05);
    expect(quoteTogglePrice(0, 0.08, true)).toBe(0.08);
    expect(quoteTogglePrice(0.05, 0.08, false)).toBe(0.08);
  });

  it("ignores a second create click until the lock is released", () => {
    const lock = { current: false };
    expect(claimInflight(lock)).toBe(true);
    expect(claimInflight(lock)).toBe(false);
    lock.current = false;
    expect(claimInflight(lock)).toBe(true);
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
