import { describe, expect, it } from "vitest";

import { apiErrorMessage } from "./api-error";
import {
  normalizedEditDraft,
  rangeIcebergEditFromExecutor,
  rangeIcebergEditPatch,
  rangeIcebergEditable,
  rangeIcebergFilledCaption,
  rangeIcebergFilledInUnit,
  validateRangeIcebergEdit,
  type RangeIcebergEditSource,
} from "./range-iceberg-edit";

function iceberg(patch: Partial<RangeIcebergEditSource> = {}): RangeIcebergEditSource {
  return {
    type: "range_iceberg_executor",
    side: "BUY",
    status: "running",
    close_type: "",
    trading_pair: "AIOT-USDT",
    config: {
      mode: "RANGE",
      size_unit: "BASE",
      total_amount: "100",
      price_low: "0.07",
      price_high: "0.09",
      take_profit: { percent: "0.02", execution: "SINGLE", order_type: "LIMIT" },
      stop_loss: { price: "0.06", execution: "SINGLE", order_type: "MARKET" },
    },
    custom_info: { filled_base: "40" },
    ...patch,
  };
}

describe("range iceberg edit", () => {
  it("prefills from decimal strings and sends nothing until a field changes", () => {
    const draft = normalizedEditDraft(rangeIcebergEditFromExecutor(iceberg()));
    expect(draft.totalAmount).toBe(100);
    expect(draft.priceLow).toBe(0.07);
    expect(draft.priceHigh).toBe(0.09);
    expect(draft.takeProfit?.percent).toBe(0.02);
    expect(draft.stopLoss?.price).toBe(0.06);
    expect(rangeIcebergFilledInUnit(iceberg())).toBe(40);
    expect(rangeIcebergEditPatch(draft, draft)).toBeNull();
  });

  it("sends only the changed amount, and null to clear an exit", () => {
    const before = normalizedEditDraft(rangeIcebergEditFromExecutor(iceberg()));
    const amount = rangeIcebergEditPatch(before, { ...before, totalAmount: 150 });
    expect(amount).toEqual({ total_amount: 150 });

    const cleared = rangeIcebergEditPatch(before, { ...before, stopLoss: null });
    expect(cleared).toEqual({ stop_loss: null });
    expect(cleared).not.toHaveProperty("take_profit");
  });

  it("sends a stop iceberg without cap behavior", () => {
    const before = normalizedEditDraft(rangeIcebergEditFromExecutor(iceberg()));
    const stop = {
      trigger: "price" as const,
      percent: 0,
      price: 0.06,
      execution: "ICEBERG" as const,
      orderType: "MARKET" as const,
      slices: 4,
      visibleCount: 1,
      interval: "30s",
      priceStyle: "RANGE" as const,
      limitPrice: 0,
      priceLow: 0.055,
      priceHigh: 0.06,
    };
    const patch = rangeIcebergEditPatch(before, { ...before, stopLoss: stop });
    expect(patch?.stop_loss).toEqual({
      execution: "ICEBERG",
      price: "0.06",
      slices: 4,
      visible_count: 1,
      interval: "30s",
      price_low: "0.055",
      price_high: "0.06",
    });
    expect(patch?.stop_loss).not.toHaveProperty("cap_behavior");
  });

  it("hides price bounds for an up-to iceberg and blocks a shrink below the fill", () => {
    const source = iceberg({
      config: {
        mode: "UP_TO",
        total_amount: 100,
        limit_price: "0.08",
        price_low: "0.01",
        price_high: "0.02",
      },
      custom_info: { filled_amount: 25 },
    });
    const before = normalizedEditDraft(rangeIcebergEditFromExecutor(source));
    expect(before.mode).toBe("UP_TO");
    expect(rangeIcebergFilledInUnit(source)).toBe(25);
    const moved = rangeIcebergEditPatch(before, {
      ...before,
      priceLow: 0.05,
      priceHigh: 0.06,
      totalAmount: 80,
    });
    expect(moved).toEqual({ total_amount: 80 });
    expect(moved).not.toHaveProperty("price_low");
    expect(validateRangeIcebergEdit({ ...before, totalAmount: 10 }, 25)).toBe(
      "Total amount cannot be below the filled amount",
    );
    expect(validateRangeIcebergEdit({ ...before, totalAmount: 25 }, 25)).toBeNull();
    expect(validateRangeIcebergEdit({ ...before, totalAmount: 10 }, null)).toBeNull();
  });

  it("compares a quote or contract total with the filled amount in that unit", () => {
    const quote = iceberg({
      config: { mode: "UP_TO", total_amount: "100", limit_price: "0.08", size_unit: "QUOTE" },
      custom_info: { filled_base: "40" },
    });
    expect(rangeIcebergFilledInUnit(quote)).toBeNull();
    expect(rangeIcebergFilledCaption(quote, "AIOT-USDT")).toBe("40 AIOT");
    const quoted = normalizedEditDraft(rangeIcebergEditFromExecutor(quote));
    expect(validateRangeIcebergEdit({ ...quoted, totalAmount: 10 }, rangeIcebergFilledInUnit(quote))).toBeNull();

    const quotedFill = iceberg({
      config: { mode: "RANGE", total_amount: "100" },
      custom_info: { filled_quote: "80", filled_base: "40" },
    });
    expect(rangeIcebergFilledInUnit(quotedFill)).toBe(80);
    expect(rangeIcebergFilledCaption(quotedFill, "AIOT-USDT")).toBe("80 USDT");
    expect(validateRangeIcebergEdit(
      { ...quoted, totalAmount: 70 },
      rangeIcebergFilledInUnit(quotedFill),
    )).toBe("Total amount cannot be below the filled amount");

    const fromPrice = iceberg({
      config: { mode: "RANGE", size_unit: "QUOTE", total_amount: "100" },
      custom_info: { filled_base: "40", average_fill_price: "2" },
    });
    expect(rangeIcebergFilledInUnit(fromPrice)).toBe(80);

    const fromAmount = iceberg({
      config: { mode: "RANGE", total_amount: "100" },
      custom_info: { filled_amount: "12.5", filled_base: "40" },
    });
    expect(rangeIcebergFilledInUnit(fromAmount)).toBe(12.5);

    const contracts = iceberg({
      config: { mode: "RANGE", size_unit: "CONTRACTS", total_amount: "10" },
      custom_info: { filled_base: "40", contract_size: "10" },
    });
    expect(rangeIcebergFilledInUnit(contracts)).toBe(4);
    expect(rangeIcebergFilledCaption(contracts, "AIOT-USDT")).toBe("4 contracts");

    const unknownContracts = iceberg({
      config: { mode: "RANGE", size_unit: "CONTRACTS", total_amount: "10" },
      custom_info: { filled_base: "40" },
    });
    expect(rangeIcebergFilledInUnit(unknownContracts)).toBeNull();

    const resumed = iceberg({
      config: { mode: "RANGE", size_unit: "QUOTE", total_amount: "100" },
      custom_info: { size_unit: "BASE", filled_base: "40", filled_quote: "80" },
    });
    expect(rangeIcebergFilledInUnit(resumed)).toBe(40);
  });

  it("does not send an exit whose numbers only changed spelling", () => {
    const before = normalizedEditDraft(rangeIcebergEditFromExecutor(iceberg({
      config: {
        mode: "RANGE",
        size_unit: "BASE",
        total_amount: "100",
        price_low: "0.07",
        price_high: "0.09",
        take_profit: {
          percent: "0.02",
          execution: "ICEBERG",
          slices: 4,
          visible_count: 1,
          interval: 5,
          limit_price: "0.1",
        },
      },
    })));
    const spelled = rangeIcebergEditPatch(before, {
      ...before,
      takeProfit: before.takeProfit ? { ...before.takeProfit, interval: "5.0" } : null,
    });
    expect(spelled).toBeNull();

    const changed = rangeIcebergEditPatch(before, {
      ...before,
      takeProfit: before.takeProfit ? { ...before.takeProfit, interval: "6" } : null,
    });
    expect(changed?.take_profit).toMatchObject({ interval: "6" });
    expect(changed).not.toHaveProperty("stop_loss");
  });

  it("rejects a long stop on the wrong side of the limit", () => {
    const before = normalizedEditDraft(rangeIcebergEditFromExecutor(iceberg({
      config: { mode: "UP_TO", total_amount: 100, limit_price: 0.08 },
    })));
    const stop = {
      trigger: "price" as const,
      percent: 0,
      price: 0.09,
      execution: "SINGLE" as const,
      orderType: "MARKET" as const,
      slices: 1,
      visibleCount: 1,
      interval: "",
      priceStyle: "LIMIT" as const,
      limitPrice: 0,
      priceLow: 0,
      priceHigh: 0,
    };
    expect(validateRangeIcebergEdit({ ...before, stopLoss: stop }, 0)).toMatch(/below the entry/);
  });

  it("hides edit for a parked hold, a closing exit, and anything that is not running", () => {
    expect(rangeIcebergEditable(iceberg())).toBe(true);
    expect(rangeIcebergEditable(iceberg({ close_type: "POSITION_HOLD" }))).toBe(false);
    expect(rangeIcebergEditable(iceberg({ close_type: "CloseType.POSITION_HOLD" }))).toBe(false);
    expect(rangeIcebergEditable(iceberg({ status: "shutting_down" }))).toBe(false);
    expect(rangeIcebergEditable(iceberg({ status: "terminated" }))).toBe(false);
    expect(rangeIcebergEditable(iceberg({
      custom_info: { exit_state: "CLOSING", filled_base: 1 },
    }))).toBe(false);
    expect(rangeIcebergEditable(iceberg({ type: "position_executor" }))).toBe(false);
  });

  it("shows a 409 reason, a 422 field error, and long instead of buy", () => {
    expect(apiErrorMessage({
      detail: { accepted: false, reason: "stop loss is closing", executor_id: "ex-1" },
    }, 409)).toBe("stop loss is closing");
    expect(apiErrorMessage({
      detail: [{ loc: ["body", "nope"], msg: "Extra inputs are not permitted" }],
    }, 422)).toBe("nope: Extra inputs are not permitted");
    expect(apiErrorMessage({
      detail: "A range iceberg is already open on AIOT-USDT SELL for master_account (executor abc). Close it first.",
    }, 409)).toContain("SHORT");
    expect(apiErrorMessage({
      detail: "A range iceberg is already open on AIOT-USDT SELL for master_account (executor abc). Close it first.",
    }, 409)).not.toContain(" SELL ");
    expect(apiErrorMessage({ detail: "Executor ex-1 not found" }, 404)).toBe(
      "Executor ex-1 not found",
    );
  });
});
