import { describe, expect, it } from "vitest";

import {
  exitPreviewText,
  exitTriggerPrice,
  icebergSentSize,
  oneAtATimeText,
  intervalFromSliceCount,
  parseDuration,
  rangeIcebergConfig,
  rangeIcebergPreview,
  mergeById,
  sameStopPriceWarning,
  scheduleNote,
  scheduleSliceCount,
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
    scheduleInterval: "2m",
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

describe("same stop price", () => {
  const open = {
    type: "range_iceberg_executor",
    side: "BUY",
    status: "running",
    trading_pair: "AIOT-USDT",
    config: { stop_loss: { price: "0.07", execution: "SINGLE" } },
    custom_info: {},
  };

  it("warns when another open iceberg on this side uses the same stop price", () => {
    const warning = sameStopPriceWarning(
      input({ mode: "UP_TO", limitPrice: 0.1, stopLoss: exit({ trigger: "price", price: 0.07 }) }),
      "AIOT-USDT",
      [open],
    );
    expect(warning).toContain("0.07");
    expect(warning).toContain("same stop price");
    expect(warning).toContain("409");
    expect(warning).toContain("Create stays off");
  });

  it("includes an iceberg from another controller in the stop check", () => {
    const visible = [{
      id: "ri-main",
      type: "range_iceberg_executor",
      side: "BUY",
      status: "running",
      trading_pair: "AIOT-USDT",
      config: { stop_loss: { price: "0.05" } },
      custom_info: {},
    }];
    const fetched = [{
      id: "ri-other",
      type: "range_iceberg_executor",
      side: "BUY",
      status: "running",
      trading_pair: "AIOT-USDT",
      config: { stop_loss: { price: "0.07" } },
      custom_info: {},
    }];
    const rows = mergeById([visible, fetched]);
    expect(rows.map((row) => row.id)).toEqual(["ri-main", "ri-other"]);
    const warning = sameStopPriceWarning(
      input({ mode: "UP_TO", limitPrice: 0.1, stopLoss: exit({ trigger: "price", price: 0.07 }) }),
      "AIOT-USDT",
      rows,
    );
    expect(warning).toContain("409");
  });

  it("warns when the open tier stores the same stop as a percent off the limit", () => {
    const draft = input({
      mode: "UP_TO",
      limitPrice: 0.08,
      stopLoss: exit({ trigger: "percent", price: 0, percent: 0.01 }),
    });
    const warning = sameStopPriceWarning(draft, "AIOT-USDT", [{
      type: "range_iceberg_executor",
      side: "BUY",
      status: "running",
      trading_pair: "AIOT-USDT",
      config: {
        mode: "UP_TO",
        limit_price: 0.08,
        stop_loss: { percent: "0.01", execution: "SINGLE" },
      },
      custom_info: {},
    }]);
    expect(warning).toContain("409");
    expect(warning).toContain("Create stays off");
  });

  it("stays quiet for a different price, side, pair, or a stopped iceberg", () => {
    const draft = input({ mode: "UP_TO", limitPrice: 0.1, stopLoss: exit({ trigger: "price", price: 0.06 }) });
    expect(sameStopPriceWarning(draft, "AIOT-USDT", [open])).toBeNull();
    expect(sameStopPriceWarning(
      input({ side: "SELL", mode: "UP_TO", limitPrice: 0.1, stopLoss: exit({ trigger: "price", price: 0.07 }) }),
      "AIOT-USDT",
      [open],
    )).toBeNull();
    expect(sameStopPriceWarning(
      input({ mode: "UP_TO", limitPrice: 0.1, stopLoss: exit({ trigger: "price", price: 0.07 }) }),
      "BTC-USDT",
      [open],
    )).toBeNull();
    expect(sameStopPriceWarning(
      input({ mode: "UP_TO", limitPrice: 0.1, stopLoss: exit({ trigger: "price", price: 0.07 }) }),
      "AIOT-USDT",
      [{ ...open, status: "terminated" }],
    )).toBeNull();
  });
});

describe("one order at a time", () => {
  it("says the next order waits for a fill", () => {
    expect(oneAtATimeText(1)).toBe(
      "One order at a time. The next is placed after the previous one fills.",
    );
    expect(oneAtATimeText(2)).toBe(
      "2 orders at a time. The next is placed after one of them fills.",
    );
  });
});

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
      perSlice: 10,
      intervalSeconds: 120,
      maxPrice: 0.09,
      sliceCount: 10,
      releaseCount: 5,
    });
  });

  it("previews a blank duration from the slice size", () => {
    const preview = rangeIcebergPreview(input({
      duration: "",
      scheduleInterval: "30s",
      sliceAmount: 25,
    }));
    expect(preview?.intervalSeconds).toBe(30);
    expect(preview?.releaseCount).toBe(4);
    expect(preview?.sliceCount).toBe(4);
  });

  it("uses levels when there is no schedule", () => {
    const preview = rangeIcebergPreview(input({ duration: "", scheduleInterval: "" }));
    expect(preview?.perSlice).toBe(10);
    expect(preview?.intervalSeconds).toBeNull();
    expect(preview?.sliceCount).toBe(10);
    expect(preview?.releaseCount).toBeNull();
  });

  it("requires a limit price in up-to mode and rejects an inverted range", () => {
    expect(validateRangeIceberg(input({ mode: "UP_TO", limitPrice: 0 }))).toMatch(/Limit price/);
    expect(validateRangeIceberg(input({ priceLow: 2, priceHigh: 1 }))).toMatch(/price low/i);
    expect(validateRangeIceberg(input({ visibleCount: 11 }))).toMatch(/Visible count/);
    expect(validateRangeIceberg(input())).toBeNull();
  });

  it("submits the executor config fields", () => {
    const config = rangeIcebergConfig(input({ mode: "UP_TO", limitPrice: 0.08, duration: "", scheduleInterval: "" }), "mexc_perpetual", "AIOT-USDT");
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
    expect(config).not.toHaveProperty("catch_up");
    expect(
      rangeIcebergConfig(input({ catchUp: "SKIP" }), "mexc_perpetual", "AIOT-USDT"),
    ).not.toHaveProperty("catch_up");
    expect(config.schedule_slices).toBeUndefined();
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
    const up = input({ mode: "UP_TO", limitPrice: 0.08, duration: "", scheduleInterval: "" });
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
    const up = input({ mode: "UP_TO", limitPrice: 0.08, duration: "", scheduleInterval: "" });
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
    const up = input({ mode: "UP_TO", limitPrice: 0.08, duration: "", scheduleInterval: "" });
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

  it("sends a schedule interval and never schedule slices", () => {
    const config = rangeIcebergConfig(input(), "mexc_perpetual", "AIOT-USDT");
    expect(config.duration).toBe("10m");
    expect(config.schedule_interval).toBe("2m");
    expect(config.schedule_start).toBe("SUBMIT");
    expect(config).not.toHaveProperty("schedule_slices");
    expect(config).not.toHaveProperty("slice_amount");
  });

  it("sends an interval when duration is blank", () => {
    const config = rangeIcebergConfig(
      input({
        duration: "",
        scheduleInterval: "30s",
        scheduleStart: "FIRST_FILL",
        sliceAmount: 25,
      }),
      "mexc_perpetual",
      "AIOT-USDT",
    );
    expect(config.duration).toBeUndefined();
    expect(config.schedule_interval).toBe("30s");
    expect(config).not.toHaveProperty("schedule_start");
    expect(config.slice_amount).toBe(25);
    expect(config.levels).toBe(10);
    expect(config).not.toHaveProperty("schedule_slices");
  });

  it("counts slices from the duration, or from size when duration is blank", () => {
    expect(scheduleSliceCount(600, 120)).toBe(5);
    expect(scheduleSliceCount(25 * 60, 10 * 60)).toBe(2);
    expect(scheduleSliceCount(60, 120)).toBeNull();
    expect(intervalFromSliceCount(3600, 7)).toBeTruthy();
    const uneven = parseDuration(intervalFromSliceCount(3600, 7) ?? "");
    expect(uneven).not.toBeNull();
    expect(scheduleSliceCount(3600, uneven ?? 0)).toBe(7);
    const sizes = { totalAmount: 100, sliceAmount: 0, levels: 10 };
    expect(scheduleSliceCount(null, 30, sizes)).toBe(10);
    expect(scheduleSliceCount(null, 30, { ...sizes, sliceAmount: 25 })).toBe(4);
    expect(scheduleSliceCount(null, 30)).toBeNull();
  });

  it("states the fill-gated release in quote and in base", () => {
    const sizes = { sliceAmount: 0, levels: 10 };
    expect(scheduleNote({
      duration: "1h",
      interval: "10m",
      total: 300,
      ...sizes,
      unit: "QUOTE",
      baseSymbol: "AIOT",
      quoteSymbol: "USDT",
      price: 0.08,
    })).toBe(
      "6 slices, about 50 USDT (\u2248 625 AIOT). Each slice goes out one interval after the previous slice fully fills.",
    );
    expect(scheduleNote({
      duration: "25m",
      interval: "10m",
      total: 100,
      ...sizes,
      unit: "BASE",
      baseSymbol: "AIOT",
      quoteSymbol: "USDT",
      price: 0.08,
    })).toBe(
      "2 slices, about 50 AIOT (\u2248 4 USDT). Each slice goes out one interval after the previous slice fully fills.",
    );
    expect(scheduleNote({
      duration: "",
      interval: "10m",
      total: 300,
      ...sizes,
      levels: 6,
      unit: "QUOTE",
      baseSymbol: "AIOT",
      quoteSymbol: "USDT",
      price: 0.08,
    })).toBe(
      "6 slices, about 50 USDT (\u2248 625 AIOT). Each slice goes out one interval after the previous slice fully fills. No time limit; runs until the full amount fills.",
    );
    expect(scheduleNote({
      duration: "",
      interval: "10m",
      total: 100,
      sliceAmount: 30,
      levels: 10,
      unit: "QUOTE",
      baseSymbol: "AIOT",
      quoteSymbol: "USDT",
      price: 0.08,
    })).toBe(
      "3 slices of 30 USDT then 10 USDT. Each slice goes out one interval after the previous slice fully fills. No time limit; runs until the full amount fills.",
    );
    expect(scheduleNote({
      duration: "",
      interval: "10m",
      total: 100,
      sliceAmount: 30,
      levels: 10,
      unit: "QUOTE",
      baseSymbol: "AIOT",
      quoteSymbol: "USDT",
      price: 0.08,
      expiry: "30m",
    })).toBe(
      "3 slices of 30 USDT then 10 USDT. Each slice goes out one interval after the previous slice fully fills. The run stops at expiry if size is still left.",
    );
  });

  it("hides the schedule note when the interval is missing", () => {
    const common = {
      interval: "10m",
      total: 300,
      sliceAmount: 0,
      levels: 10,
      unit: "QUOTE" as const,
      baseSymbol: "AIOT",
      quoteSymbol: "USDT",
      price: 0.08,
    };
    expect(scheduleNote({ ...common, duration: "1h", interval: "" })).toBeNull();
    expect(scheduleNote({ ...common, duration: "10m", interval: "soon" })).toBeNull();
  });

  it("rejects a missing, invalid, or too-long schedule interval", () => {
    expect(validateRangeIceberg(input({ scheduleInterval: "" }))).toBe(
      "A duration needs a schedule interval",
    );
    expect(validateRangeIceberg(input({ duration: "", scheduleInterval: "30s" }))).toBeNull();
    expect(validateRangeIceberg(input({ scheduleInterval: "soon" }))).toBe(
      "Schedule interval must be seconds or a value like 30s",
    );
    expect(validateRangeIceberg(input({ scheduleInterval: "0" }))).toBe(
      "Schedule interval must be greater than 0",
    );
    expect(validateRangeIceberg(input({ duration: "10m", scheduleInterval: "1h" }))).toBe(
      "Schedule interval cannot be longer than the duration",
    );
    expect(validateRangeIceberg(input({ duration: "0", scheduleInterval: "30s" }))).toBe(
      "Duration must be greater than 0",
    );
    expect(validateRangeIceberg(input({ duration: "0s", scheduleInterval: "1m" }))).toBe(
      "Duration must be greater than 0",
    );
    expect(validateRangeIceberg(input({ sliceAmount: -1 }))).toBe(
      "Slice amount must be greater than 0",
    );
    expect(validateRangeIceberg(input({ sliceAmount: 0 }))).toBeNull();
  });

  it("sends a quote range as quote and previews each rung", () => {
    const sized = input({
      sizeUnit: "QUOTE",
      totalAmount: 100,
      levels: 2,
      duration: "",
      scheduleInterval: "",
    });
    const sent = icebergSentSize(sized, null, 0.09, false);
    expect(sent.error).toBeNull();
    expect(sent.sizeUnit).toBe("QUOTE");
    expect(sent.total).toBe(100);
    expect(sent.baseTotal).toBeCloseTo(50 / 0.07 + 50 / 0.09, 4);
    expect(sent.baseTotal).toBeGreaterThan(100 / 0.09);
    const config = rangeIcebergConfig(
      { ...sized, totalAmount: sent.total, sizeUnit: sent.sizeUnit },
      "mexc_perpetual",
      "AIOT-USDT",
    );
    expect(config.size_unit).toBe("QUOTE");
    expect(config.total_amount).toBe(100);
    expect(config).not.toHaveProperty("slice_amount");
    expect(config).not.toHaveProperty("schedule_start");
    const perRung = sent.baseTotal / 5;
    const noted = scheduleNote({
      duration: "10m",
      interval: "2m",
      total: 100,
      sliceAmount: 0,
      levels: 10,
      unit: "QUOTE",
      baseSymbol: "AIOT",
      quoteSymbol: "USDT",
      price: 0.09,
      baseTotal: sent.baseTotal,
    });
    expect(perRung).toBeGreaterThan(100 / 0.09 / 5);
    expect(noted).toContain("about 20 USDT");
    expect(noted).toContain("AIOT");
    expect(noted).not.toContain("222");
  });

  it("sends an up-to quote order as quote, estimated at the limit", () => {
    const sent = icebergSentSize(input({
      mode: "UP_TO",
      sizeUnit: "QUOTE",
      totalAmount: 80,
      limitPrice: 0.08,
      duration: "",
      scheduleInterval: "",
    }), null, 0.08, false);
    expect(sent.sizeUnit).toBe("QUOTE");
    expect(sent.total).toBe(80);
    expect(sent.baseTotal).toBeCloseTo(1000, 6);
    const capped = icebergSentSize(input({
      mode: "UP_TO",
      sizeUnit: "QUOTE",
      totalAmount: 80,
      limitPrice: 0.08,
      duration: "",
      scheduleInterval: "",
    }), null, 0.08, false, 500);
    expect(capped.total).toBeCloseTo(40, 6);
    expect(capped.sizeUnit).toBe("QUOTE");
  });

  it("sends a slice amount only when the trader set one", () => {
    const config = rangeIcebergConfig(
      input({ sliceAmount: 12, duration: "", scheduleInterval: "" }),
      "mexc_perpetual",
      "AIOT-USDT",
    );
    expect(config.slice_amount).toBe(12);
  });

  it("parses a friendly expiry and sends seconds", () => {
    const config = rangeIcebergConfig(
      input({ expiry: "30m", duration: "", scheduleInterval: "" }),
      "mexc_perpetual",
      "AIOT-USDT",
    );
    expect(config.expiry_seconds).toBe(1800);
    expect(validateRangeIceberg(input({ expiry: "soon" }))).toMatch(/Expiry/);
  });

  it("rejects a stop or take profit on the wrong side of the range", () => {
    expect(validateRangeIceberg(input({
      stopLoss: exit({ trigger: "price", price: 0.075, percent: 0 }),
    }))).toMatch(/below price low/);
    expect(validateRangeIceberg(input({
      stopLoss: exit({ trigger: "price", price: 0.06, percent: 0 }),
    }))).toBeNull();
    expect(validateRangeIceberg(input({
      side: "SELL",
      stopLoss: exit({ trigger: "price", price: 0.085, percent: 0 }),
    }))).toMatch(/above price high/);
    expect(validateRangeIceberg(input({
      takeProfit: exit({ trigger: "price", price: 0.09, percent: 0 }),
    }))).toMatch(/above price high/);
    expect(validateRangeIceberg(input({
      takeProfit: exit({ trigger: "price", price: 0.1, percent: 0 }),
    }))).toBeNull();
    expect(validateRangeIceberg(input({
      takeProfit: exit({ trigger: "percent", percent: 0.02 }),
    }))).toBeNull();
  });

  it("caps size and price jitter at 100 percent", () => {
    expect(validateRangeIceberg(input({ sizeJitterPct: 1.5 }))).toMatch(/Size jitter/);
    expect(validateRangeIceberg(input({ priceJitterPct: 1.5 }))).toMatch(/Price jitter/);
    expect(validateRangeIceberg(input({ sizeJitterPct: 0.05 }))).toBeNull();
  });
});
