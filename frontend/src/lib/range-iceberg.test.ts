import { describe, expect, it } from "vitest";

import {
  parseDuration,
  rangeIcebergConfig,
  rangeIcebergPreview,
  validateRangeIceberg,
  type RangeIcebergInput,
} from "./range-iceberg";

function input(over: Partial<RangeIcebergInput> = {}): RangeIcebergInput {
  return {
    side: "BUY",
    mode: "RANGE",
    totalAmount: 100,
    sizeUnit: "BASE",
    priceLow: 0.07,
    priceHigh: 0.09,
    limitPrice: 0,
    iceberg: true,
    visibleCount: 2,
    levels: 10,
    duration: "10m",
    scheduleSlices: 5,
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
    ...over,
  };
}

describe("range iceberg", () => {
  it("parses the duration spellings the executor accepts", () => {
    expect(parseDuration("24h")).toBe(86400);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("1d")).toBe(86400);
    expect(parseDuration("nope")).toBeNull();
  });

  it("previews total, per-slice size, interval and max price", () => {
    const preview = rangeIcebergPreview(input());
    expect(preview).toMatchObject({
      total: 100,
      perSlice: 20,
      intervalSeconds: 120,
      maxPrice: 0.09,
      sliceCount: 5,
    });
  });

  it("uses levels when there is no schedule", () => {
    const preview = rangeIcebergPreview(input({ duration: "", scheduleSlices: 0 }));
    expect(preview?.perSlice).toBe(10);
    expect(preview?.intervalSeconds).toBeNull();
    expect(preview?.sliceCount).toBe(10);
  });

  it("requires a limit price in up-to mode and rejects an inverted range", () => {
    expect(validateRangeIceberg(input({ mode: "UP_TO", limitPrice: 0 }))).toMatch(/Limit price/);
    expect(validateRangeIceberg(input({ priceLow: 2, priceHigh: 1 }))).toMatch(/price low/i);
    expect(validateRangeIceberg(input({ visibleCount: 11 }))).toMatch(/Visible count/);
    expect(validateRangeIceberg(input())).toBeNull();
  });

  it("submits the executor config fields", () => {
    const config = rangeIcebergConfig(input({ mode: "UP_TO", limitPrice: 0.08, duration: "" , scheduleSlices: 0 }), "mexc_perpetual", "AIOT-USDT");
    expect(config).toMatchObject({
      connector_name: "mexc_perpetual",
      trading_pair: "AIOT-USDT",
      side: "BUY",
      total_amount: 100,
      size_unit: "BASE",
      mode: "UP_TO",
      limit_price: 0.08,
      iceberg: true,
      visible_count: 2,
      leverage: 2,
      margin_mode: "ISOLATED",
      reduce_only: false,
      min_order_interval: 0.6,
    });
    expect(config.duration).toBeUndefined();
    expect(config.price_low).toBeUndefined();
  });
});
