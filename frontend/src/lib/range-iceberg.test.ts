import { describe, expect, it } from "vitest";

import {
  exitPreviewText,
  exitTriggerPrice,
  parseDuration,
  rangeIcebergConfig,
  rangeIcebergPreview,
  validateRangeIceberg,
  type RangeIcebergExitInput,
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

function exit(over: Partial<RangeIcebergExitInput> = {}): RangeIcebergExitInput {
  return {
    trigger: "percent",
    percent: 0.02,
    price: 0,
    execution: "SINGLE",
    orderType: "LIMIT",
    slices: 1,
    visibleCount: 1,
    interval: "",
    priceStyle: "LIMIT",
    limitPrice: 0,
    priceLow: 0,
    priceHigh: 0,
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
      reduce_only: false,
      min_order_interval: 0.6,
    });
    expect(config.duration).toBeUndefined();
    expect(config.price_low).toBeUndefined();
    expect(config.margin_mode).toBeUndefined();
    expect(rangeIcebergConfig(input(), "mexc_perpetual", "AIOT-USDT", true).margin_mode).toBe(
      "ISOLATED",
    );
  });

  it("omits take profit and stop loss while they are off", () => {
    const config = rangeIcebergConfig(input(), "mexc_perpetual", "AIOT-USDT");
    expect(config.take_profit).toBeUndefined();
    expect(config.stop_loss).toBeUndefined();
    expect(config.exit_arming).toBeUndefined();
  });

  it("submits the example exit config", () => {
    const config = rangeIcebergConfig(
      input({
        mode: "UP_TO",
        limitPrice: 0.08,
        exitArming: "ON_FULL_FILL",
        takeProfit: exit({ percent: 0.02, execution: "SINGLE", orderType: "LIMIT" }),
        stopLoss: exit({
          percent: 0.01,
          execution: "ICEBERG",
          slices: 4,
          visibleCount: 1,
          interval: "30s",
          priceStyle: "LIMIT",
          limitPrice: 0.07,
        }),
      }),
      "mexc_perpetual",
      "AIOT-USDT",
    );
    expect(config.exit_arming).toBe("ON_FULL_FILL");
    expect(config.take_profit).toEqual({
      percent: "0.02",
      execution: "SINGLE",
      order_type: "LIMIT",
    });
    expect(config.stop_loss).toEqual({
      percent: "0.01",
      execution: "ICEBERG",
      slices: 4,
      visible_count: 1,
      interval: "30s",
      limit_price: "0.07",
      cap_behavior: "REST_AT_CAP",
    });
  });

  it("sends a market take profit and a ranged iceberg stop without an order type", () => {
    const config = rangeIcebergConfig(
      input({
        takeProfit: exit({ orderType: "MARKET" }),
        stopLoss: exit({
          execution: "SINGLE",
          orderType: "LIMIT",
          percent: 0.01,
        }),
      }),
      "mexc_perpetual",
      "AIOT-USDT",
    );
    expect(config.take_profit).toEqual({
      percent: "0.02",
      execution: "SINGLE",
      order_type: "MARKET",
    });
    expect(config.stop_loss).toEqual({
      percent: "0.01",
      execution: "SINGLE",
      order_type: "MARKET",
    });

    const ranged = rangeIcebergConfig(
      input({
        stopLoss: exit({
          percent: 0.01,
          execution: "ICEBERG",
          slices: 3,
          visibleCount: 2,
          interval: "",
          priceStyle: "RANGE",
          priceLow: 0.06,
          priceHigh: 0.075,
        }),
      }),
      "mexc_perpetual",
      "AIOT-USDT",
    );
    expect(ranged.stop_loss).toEqual({
      percent: "0.01",
      execution: "ICEBERG",
      slices: 3,
      visible_count: 2,
      price_low: "0.06",
      price_high: "0.075",
      cap_behavior: "REST_AT_CAP",
    });
    expect(ranged.exit_arming).toBe("ON_FULL_FILL");
  });

  it("rests a stop loss iceberg at the cap when the entry is set to wait", () => {
    const config = rangeIcebergConfig(
      input({
        capBehavior: "WAIT",
        takeProfit: exit({
          execution: "ICEBERG",
          slices: 2,
          visibleCount: 1,
          priceStyle: "LIMIT",
          limitPrice: 0.09,
        }),
        stopLoss: exit({
          percent: 0.01,
          execution: "ICEBERG",
          slices: 4,
          visibleCount: 1,
          priceStyle: "LIMIT",
          limitPrice: 0.07,
        }),
      }),
      "mexc_perpetual",
      "AIOT-USDT",
    );
    expect(config.cap_behavior).toBe("WAIT");
    expect(config.stop_loss).toMatchObject({ cap_behavior: "REST_AT_CAP" });
    expect(config.take_profit).not.toHaveProperty("cap_behavior");
  });

  it("previews long and short triggers from the limit", () => {
    const reference = { price: 0.08, label: "limit" };
    const take = exit({ percent: 0.02 });
    expect(exitTriggerPrice("BUY", "take_profit", take, 0.08)).toBeCloseTo(0.0816);
    expect(exitTriggerPrice("SELL", "take_profit", take, 0.08)).toBeCloseTo(0.0784);
    expect(exitTriggerPrice("BUY", "stop_loss", exit({ percent: 0.01 }), 0.08)).toBeCloseTo(0.0792);
    expect(exitTriggerPrice("SELL", "stop_loss", exit({ percent: 0.01 }), 0.08)).toBeCloseTo(0.0808);
    expect(exitPreviewText("take_profit", take, reference)).toBe(
      "Estimate based on limit 0.08: long 0.0816, short 0.0784.",
    );
    expect(exitPreviewText("stop_loss", exit({ percent: 0.01 }), { price: 0.08, label: "range mid" })).toBe(
      "Estimate based on range mid 0.08: long 0.0792, short 0.0808.",
    );
    expect(exitPreviewText("take_profit", exit({ trigger: "price", price: 0.09 }), reference)).toBe(
      "Long 0.09, short 0.09.",
    );
    expect(exitPreviewText("take_profit", exit({ percent: 0 }), null)).toMatch(/entry or limit/);
  });

  it("rejects a percent outside (0, 1) and a trigger on the wrong side of the entry", () => {
    const up = input({ mode: "UP_TO", limitPrice: 0.08, duration: "", scheduleSlices: 0 });
    expect(validateRangeIceberg(up)).toBeNull();
    for (const percent of [0, 1, 1.5, -0.01]) {
      expect(validateRangeIceberg({ ...up, takeProfit: exit({ percent }) })).toMatch(/less than 1/);
    }
    expect(
      validateRangeIceberg({
        ...up,
        takeProfit: exit({ trigger: "price", price: 0.07 }),
      }),
    ).toMatch(/above the entry for a long/);
    expect(
      validateRangeIceberg({
        ...up,
        side: "SELL",
        takeProfit: exit({ trigger: "price", price: 0.09 }),
      }),
    ).toMatch(/below the entry for a short/);
    expect(
      validateRangeIceberg({
        ...up,
        stopLoss: exit({ trigger: "price", price: 0.09, percent: 0 }),
      }),
    ).toMatch(/below the entry for a long/);
    expect(
      validateRangeIceberg({
        ...up,
        side: "SELL",
        stopLoss: exit({ trigger: "price", price: 0.07 }),
      }),
    ).toMatch(/above the entry for a short/);
    expect(
      validateRangeIceberg({
        ...up,
        takeProfit: exit({ trigger: "price", price: 0.09 }),
        stopLoss: exit({ trigger: "price", price: 0.07 }),
      }),
    ).toBeNull();
  });

  it("requires an iceberg limit or range, and keeps visible count within slices", () => {
    const up = input({ mode: "UP_TO", limitPrice: 0.08, duration: "", scheduleSlices: 0 });
    expect(
      validateRangeIceberg({
        ...up,
        stopLoss: exit({
          percent: 0.01,
          execution: "ICEBERG",
          slices: 4,
          visibleCount: 5,
          priceStyle: "LIMIT",
          limitPrice: 0.07,
        }),
      }),
    ).toMatch(/visible count cannot exceed slices/i);
    expect(
      validateRangeIceberg({
        ...up,
        stopLoss: exit({
          percent: 0.01,
          execution: "ICEBERG",
          priceStyle: "LIMIT",
          limitPrice: 0,
        }),
      }),
    ).toMatch(/limit price, or a price low/);
    expect(
      validateRangeIceberg({
        ...up,
        takeProfit: exit({
          execution: "ICEBERG",
          priceStyle: "RANGE",
          priceLow: 0.09,
          priceHigh: 0.085,
        }),
      }),
    ).toMatch(/price low must be at or below price high/);
    expect(
      validateRangeIceberg({
        ...up,
        takeProfit: exit({ execution: "ICEBERG", interval: "soon", priceStyle: "LIMIT", limitPrice: 0.09 }),
      }),
    ).toMatch(/interval/);
    expect(
      validateRangeIceberg({
        ...up,
        reduceOnly: true,
        takeProfit: exit(),
      }),
    ).toMatch(/reduce only/);
  });

  it("rejects a stop loss iceberg whose limit or range is on the wrong side of the trigger", () => {
    const up = input({ mode: "UP_TO", limitPrice: 0.08, duration: "", scheduleSlices: 0 });
    const iceberg = {
      percent: 0.01,
      execution: "ICEBERG" as const,
      slices: 2,
      visibleCount: 1,
    };
    expect(
      validateRangeIceberg({
        ...up,
        stopLoss: exit({ ...iceberg, priceStyle: "LIMIT", limitPrice: 0.09 }),
      }),
    ).toMatch(/limit must be at or below the trigger for a long/);
    expect(
      validateRangeIceberg({
        ...up,
        stopLoss: exit({ ...iceberg, priceStyle: "LIMIT", limitPrice: 0.0792 }),
      }),
    ).toBeNull();
    expect(
      validateRangeIceberg({
        ...up,
        stopLoss: exit({ ...iceberg, priceStyle: "RANGE", priceLow: 0.07, priceHigh: 0.085 }),
      }),
    ).toMatch(/price bounds must be at or below the trigger for a long/);
    expect(
      validateRangeIceberg({
        ...up,
        side: "SELL",
        stopLoss: exit({ ...iceberg, priceStyle: "LIMIT", limitPrice: 0.07 }),
      }),
    ).toMatch(/limit must be at or above the trigger for a short/);
    expect(
      validateRangeIceberg({
        ...up,
        side: "SELL",
        stopLoss: exit({ ...iceberg, priceStyle: "RANGE", priceLow: 0.07, priceHigh: 0.09 }),
      }),
    ).toMatch(/price bounds must be at or above the trigger for a short/);
    expect(
      validateRangeIceberg({
        ...up,
        side: "SELL",
        stopLoss: exit({ ...iceberg, priceStyle: "LIMIT", limitPrice: 0.0808 }),
      }),
    ).toBeNull();
    expect(
      validateRangeIceberg({
        ...up,
        side: "SELL",
        stopLoss: exit({ ...iceberg, priceStyle: "RANGE", priceLow: 0.081, priceHigh: 0.09 }),
      }),
    ).toBeNull();
    expect(
      validateRangeIceberg({
        ...up,
        stopLoss: exit({
          trigger: "price",
          price: 0.07,
          execution: "ICEBERG",
          slices: 2,
          visibleCount: 1,
          priceStyle: "LIMIT",
          limitPrice: 0.075,
        }),
      }),
    ).toMatch(/limit must be at or below the trigger for a long/);
    expect(
      validateRangeIceberg({
        ...up,
        takeProfit: exit({
          execution: "ICEBERG",
          slices: 2,
          visibleCount: 1,
          priceStyle: "LIMIT",
          limitPrice: 0.09,
        }),
      }),
    ).toBeNull();
  });
});
