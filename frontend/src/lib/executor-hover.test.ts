import { describe, expect, it } from "vitest";

import type { ExecutorInfo } from "@/lib/api";
import { executorHoverModel, formatStartMyt, placePopup } from "@/lib/executor-hover";

function executor(patch: Partial<ExecutorInfo> = {}): ExecutorInfo {
  return {
    id: "ri-1",
    type: "range_iceberg_executor",
    connector: "mexc_perpetual",
    trading_pair: "AIOT-USDT",
    side: "BUY",
    status: "running",
    close_type: "",
    pnl: 0.75,
    volume: 0,
    timestamp: 1_700_000_000,
    controller_id: "main",
    cum_fees_quote: 0,
    net_pnl_pct: 0,
    entry_price: 0,
    current_price: 0,
    close_timestamp: 0,
    custom_info: {},
    config: {},
    ...patch,
  };
}

const STARTED = 1_700_000_000_000;

describe("executor hover details", () => {
  it("reads an up-to iceberg from config and custom_info", () => {
    const model = executorHoverModel(
      executor({
        close_type: "EARLY_STOP",
        config: {
          mode: "UP_TO",
          position_side: "LONG",
          total_amount: 30000,
          size_unit: "BASE",
          limit_price: 0.081,
          iceberg: true,
          visible_count: 2,
          levels: 4,
          slice_amount: 1500,
          duration: "1h",
          schedule_slices: 10,
          schedule_interval: 30,
          cap_behavior: "REST_AT_CAP",
          catch_up: "CARRY",
          reduce_only: false,
          leverage: 1,
          margin_mode: "ISOLATED",
        },
        custom_info: {
          filled_amount: 12000,
          average_fill_price: 0.0805,
          realized_pnl_quote: 1.25,
          unrealized_pnl_quote: -0.5,
          status_reason: "Cancel was not confirmed on the exchange",
          open_orders: [
            {
              price: 0.081,
              amount: 1500,
              filled_amount: 100,
              exchange_order_id: "ex-1",
              status: "OPEN",
            },
            {
              price: 0.08,
              amount: 1500,
              filled_amount: 1500,
              exchange_order_id: "ex-filled",
              status: "FILLED",
            },
          ],
          orders: [
            { price: 0.079, amount: 1500, status: "CANCELED", order_id: "gone" },
            {
              price: 0.082,
              amount: 400,
              filled: 5,
              status: "PARTIALLY_FILLED",
              exchange_order_id: "ex-3",
            },
          ],
        },
      }),
      STARTED + 600_000,
    );

    expect(model.type).toBe("Range iceberg");
    expect(model.side).toBe("BUY");
    expect(model.positionSide).toBe("LONG");
    expect(model.rows).toEqual(
      expect.arrayContaining([
        { label: "Mode", value: "Up to" },
        { label: "Size", value: "30000 BASE, 12000 filled (40.0%)" },
        { label: "Limit", value: "0.081" },
        { label: "Iceberg", value: "Yes" },
        { label: "Visible", value: "2" },
        { label: "Levels", value: "4" },
        { label: "Slice", value: "1500 BASE" },
        { label: "Duration", value: "1h" },
        { label: "Schedule", value: "10 slices, every 30s" },
        { label: "Remaining", value: "50m" },
        { label: "Cap", value: "Rest at cap" },
        { label: "Catch up", value: "Carry" },
        { label: "Reduce only", value: "No" },
        { label: "Avg fill", value: "0.0805" },
        { label: "Net PnL", value: "+0.7500" },
        { label: "Started", value: formatStartMyt(STARTED) },
      ]),
    );
    for (const dropped of ["Leverage", "Margin", "Realized", "Unrealized"]) {
      expect(model.rows.map((row) => row.label)).not.toContain(dropped);
    }
    expect(model.rows.find((row) => row.label === "Started")?.value).toContain("MYT");
    expect(JSON.stringify(model)).not.toContain("ex-1");
    expect(JSON.stringify(model)).not.toContain("ISOLATED");
    expect(model.orders).toEqual([
      { price: "0.081", amount: "1500", filled: "100", status: "OPEN" },
      { price: "0.082", amount: "400", filled: "5", status: "PARTIALLY_FILLED" },
    ]);
    expect(model.closeType).toBe("Early Stop");
    expect(model.statusMessage).toBe("Cancel was not confirmed on the exchange");
  });

  it("shows a range as low to high and skips fields the executor does not have", () => {
    const ranged = executorHoverModel(
      executor({
        config: { mode: "RANGE", price_low: 0.07, price_high: 0.09, total_amount: 100 },
        custom_info: { filled_amount: 20, levels: [{ price: 0.08 }] },
      }),
    );
    expect(ranged.rows.find((row) => row.label === "Mode")?.value).toBe("Range");
    expect(ranged.rows.find((row) => row.label === "Range")?.value).toBe("0.07 to 0.09");
    expect(ranged.rows.find((row) => row.label === "Limit")).toBeUndefined();
    expect(ranged.orders).toEqual([]);

    const bare = executorHoverModel(
      executor({
        type: "order_executor",
        timestamp: 0,
        pnl: 0,
        close_type: "",
      }),
    );
    expect(bare.rows.map((row) => row.label)).toEqual(["Net PnL"]);
    expect(bare.orders).toEqual([]);
    expect(bare.closeType).toBe("");
    expect(bare.statusMessage).toBe("");
  });
});

describe("placePopup", () => {
  it("pins a card that would leave the right edge, and drops below a row at the top", () => {
    const placed = placePopup(
      { top: 10, left: 700, bottom: 30, width: 120 },
      { width: 320, height: 200 },
      { width: 800, height: 600 },
    );
    expect(placed.left).toBe(472);
    expect(placed.top).toBe(26);
  });

  it("prefers above the row, and pins to the bottom edge when below would clip", () => {
    const above = placePopup(
      { top: 500, left: 16, bottom: 520, width: 200 },
      { width: 320, height: 180 },
      { width: 800, height: 600 },
    );
    expect(above.top).toBe(324);

    const pinned = placePopup(
      { top: 400, left: 16, bottom: 420, width: 200 },
      { width: 320, height: 400 },
      { width: 800, height: 600 },
    );
    expect(pinned.top).toBe(192);
    expect(pinned.maxHeight).toBe(584);
  });
});
