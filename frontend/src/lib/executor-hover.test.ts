import { describe, expect, it } from "vitest";

import type { ExecutorInfo } from "@/lib/api";
import { executorHoverModel, formatStartMyt, placePopup } from "@/lib/executor-hover";
import { executorRunDetail, rangeIcebergTierLine } from "@/lib/executor-run";

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

    expect(model.type).toBe("Limit iceberg");
    expect(model.side).toBe("BUY");
    expect(model.positionSide).toBe("LONG");
    expect(model.rows).toEqual(
      expect.arrayContaining([
        { label: "Mode", value: "Up to" },
        { label: "Size", value: "30,000 AIOT (approx 2,415 USDT), 12,000 filled (40.0%, approx 966 USDT)" },
        { label: "Limit", value: "0.081" },
        { label: "Iceberg", value: "Yes" },
        { label: "Visible", value: "2" },
        { label: "Levels", value: "4" },
        { label: "Slice", value: "1,500 AIOT (approx 120.75 USDT)" },
        { label: "Duration", value: "1h" },
        { label: "Schedule", value: "every 30s, 250 AIOT (approx 20.125 USDT)" },
        { label: "Remaining", value: "50m" },
        { label: "Cap", value: "Rest at cap" },
        { label: "Catch up", value: "Carry" },
        { label: "Reduce only", value: "No" },
        { label: "Avg fill", value: "0.0805" },
        { label: "Started", value: formatStartMyt(STARTED) },
      ]),
    );
    for (const dropped of ["Leverage", "Margin", "Realized", "Unrealized", "Net PnL"]) {
      expect(model.rows.map((row) => row.label)).not.toContain(dropped);
    }
    expect(model.rows.find((row) => row.label === "Started")?.value).toContain("MYT");
    expect(JSON.stringify(model)).not.toContain("ex-1");
    expect(JSON.stringify(model)).not.toContain("ISOLATED");
    expect(model.orders).toEqual([
      { price: "0.081", amount: "1500", filled: "100", status: "OPEN" },
      { price: "0.082", amount: "400", filled: "5", status: "PARTIALLY_FILLED" },
    ]);
    expect(model.rows.map((row) => row.value).join(" ")).not.toMatch(/\b(BASE|QUOTE|CONTRACTS)\b/);
    expect(model.closeType).toBe("Early Stop");
    expect(model.statusMessage).toBe("Cancel was not confirmed on the exchange");
  });

  it("derives the interval when an older config only stored schedule slices", () => {
    const model = executorHoverModel(executor({
      config: {
        total_amount: 300,
        size_unit: "BASE",
        duration: "1h",
        schedule_slices: 6,
      },
    }));
    expect(model.rows).toEqual(expect.arrayContaining([
      { label: "Schedule", value: "every 10m, 50 AIOT" },
    ]));
  });

  it("prices a base size from the mid when nothing has filled", () => {
    const model = executorHoverModel(
      executor({
        type: "order_executor",
        timestamp: 0,
        pnl: 0,
        current_price: 0,
        config: { amount: 1000, size_unit: "BASE" },
        custom_info: {},
      }),
      0,
      0.08,
    );
    expect(model.rows.find((row) => row.label === "Size")?.value).toBe("1,000 AIOT (approx 80 USDT)");
  });

  it("labels a quote size with the quote token", () => {
    const model = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        config: { size_unit: "QUOTE", total_amount: 2430 },
        custom_info: {},
      }),
    );
    expect(model.rows.find((row) => row.label === "Size")?.value).toBe("2,430 USDT");
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
    expect(bare.rows).toEqual([]);
    expect(bare.orders).toEqual([]);
    expect(bare.closeType).toBe("");
    expect(bare.statusMessage).toBe("");
  });

  it("shows range iceberg exit progress from custom_info", () => {
    const model = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: {
          take_profit_trigger_price: "0.0816",
          stop_loss_trigger_price: "0.0792",
          exit_status: "executing",
          exit_active: "stop_loss",
          exit_filled_amount: "2500",
          exit_average_price: "0.079",
          realized_pnl_quote: "-12.5",
        },
      }),
    );
    expect(model.rows).toEqual(
      expect.arrayContaining([
        { label: "TP trigger", value: "0.0816" },
        { label: "SL trigger", value: "0.0792" },
        { label: "Exit status", value: "Executing" },
        { label: "Exit", value: "Stop Loss" },
        { label: "Exit filled", value: "2,500 AIOT" },
        { label: "Exit avg", value: "0.079" },
        { label: "Realized PnL", value: "-12.5 USDT" },
      ]),
    );
  });

  it("leaves an idle exit with no trigger off the card", () => {
    const model = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: {
          exit_status: "idle",
          exit_active: null,
          take_profit_trigger_price: null,
          stop_loss_trigger_price: null,
          exit_filled_amount: "0",
          exit_average_price: "0",
          realized_pnl_quote: "0",
        },
      }),
    );
    expect(model.rows.map((row) => row.label)).not.toContain("Exit status");
    expect(model.rows.map((row) => row.label)).not.toContain("Realized PnL");
  });

  it("labels a resting limit take profit without treating it as triggered", () => {
    const model = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        config: { mode: "UP_TO", limit_price: 0.08, take_profit: { percent: "0.02" } },
        custom_info: {
          exit_state: "RESTING",
          exit_status: "executing",
          exit_active: "take_profit",
          take_profit_trigger_price: "0.0825",
          filled_amount: "12000",
          filled_base: "12000",
          open_base: "12000",
          closed_base: "0",
          exchange_stop_order_id: "exch-stop-44",
          exit_order_ids: ["tp-a", "tp-b"],
        },
      }),
    );
    expect(model.rows.find((row) => row.label === "Exit status")?.value).toBe("TP resting");
    expect(model.rows.find((row) => row.label === "Exit")).toBeUndefined();
    expect(model.rows.map((row) => row.value)).not.toContain("Executing");
    expect(model.rows.map((row) => row.value)).not.toContain("Take Profit");
    // 2% of the 0.08 limit would be 0.0816. The card shows the executor price.
    expect(model.rows.find((row) => row.label === "TP trigger")?.value).toBe("0.0825");
    expect(model.rows.find((row) => row.label === "Tier open")?.value).toBe("12,000 AIOT");
    expect(model.rows.find((row) => row.label === "Exchange stop")?.value).toBe("In place");
    expect(model.rows.find((row) => row.label === "Exit orders")?.value).toBe("2");
    const dumped = JSON.stringify(model);
    expect(dumped).not.toContain("exch-stop-44");
    expect(dumped).not.toContain("tp-a");
    expect(dumped).not.toContain("0.0816");
  });

  it("uses distinct exit_state labels and names the exit only after it starts", () => {
    const cases = [
      ["ARMED", "Armed", false],
      ["TRIGGERED", "Triggered", true],
      ["CLOSING", "Closing", true],
      ["DONE", "Done", true],
    ] as const;
    for (const [state, label, showKind] of cases) {
      const model = executorHoverModel(
        executor({
          timestamp: 0,
          pnl: 0,
          custom_info: {
            exit_state: state,
            exit_status: "executing",
            exit_active: "take_profit",
            open_base: state === "DONE" ? "0" : "4",
          },
        }),
      );
      expect(model.rows.find((row) => row.label === "Exit status")?.value).toBe(label);
      expect(model.rows.find((row) => row.label === "Exit")?.value).toBe(
        showKind ? "Take Profit" : undefined,
      );
      expect(model.rows.map((row) => row.value)).not.toContain("Executing");
    }
  });

  it("ignores a stale executing status when exit_state is none", () => {
    const model = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: {
          exit_state: "NONE",
          exit_status: "executing",
          exit_active: "take_profit",
        },
      }),
    );
    expect(model.rows.map((row) => row.label)).not.toContain("Exit status");
    expect(model.rows.map((row) => row.label)).not.toContain("Exit");
  });

  it("does not invent a trigger from the limit when the executor has not sent one", () => {
    const model = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        config: {
          mode: "UP_TO",
          limit_price: 0.08,
          take_profit: { percent: "0.02", execution: "SINGLE", order_type: "LIMIT" },
        },
        custom_info: {
          exit_state: "ARMED",
          filled_base: "100",
          open_base: "100",
        },
      }),
    );
    expect(model.rows.find((row) => row.label === "Exit status")?.value).toBe("Armed");
    expect(model.rows.find((row) => row.label === "TP trigger")).toBeUndefined();
    expect(model.rows.find((row) => row.label === "Tier open")?.value).toBe("100 AIOT");
    expect(JSON.stringify(model)).not.toContain("0.0816");
  });

  it("reads filled_base when filled_amount is absent and prefers closed_base", () => {
    const sized = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        config: { total_amount: 1000, size_unit: "BASE" },
        custom_info: { filled_base: "250" },
      }),
    );
    expect(sized.rows.find((row) => row.label === "Size")?.value).toBe("1,000 AIOT, 250 filled (25.0%)");

    const closing = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: {
          exit_state: "CLOSING",
          exit_active: "stop_loss",
          closed_base: "40",
          exit_filled_amount: "10",
          open_base: "60",
        },
      }),
    );
    expect(closing.rows.find((row) => row.label === "Exit filled")?.value).toBe("40 AIOT");
    expect(closing.rows.find((row) => row.label === "Exit status")?.value).toBe("Closing");
    expect(closing.rows.find((row) => row.label === "Exit")?.value).toBe("Stop Loss");
    expect(closing.rows.find((row) => row.label === "Tier open")?.value).toBe("60 AIOT");
  });

  it("badges a deeper-tier pause and keeps exits active", () => {
    const model = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        config: {
          mode: "UP_TO",
          limit_price: 0.1,
          take_profit: { percent: "0.02", execution: "SINGLE", order_type: "LIMIT" },
          stop_loss: { price: "0.07", execution: "SINGLE", order_type: "MARKET" },
        },
        custom_info: {
          entry_paused: true,
          pause_reason: "deeper tier active",
          exit_state: "RESTING",
          exit_active: "take_profit",
          take_profit_trigger_price: "0.102",
          stop_loss_trigger_price: "0.07",
          open_base: "10",
        },
      }),
    );
    expect(model.entryPaused).toBe(true);
    expect(model.pauseReason).toBe("deeper tier active");
    expect(model.rows.find((row) => row.label === "Paused")?.value).toBe("deeper tier active");
    expect(model.rows.find((row) => row.label === "Exits")?.value).toBe("TP and SL active");
    expect(model.rows.find((row) => row.label === "Exit status")?.value).toBe("TP resting");
    expect(model.rows.find((row) => row.label === "TP trigger")?.value).toBe("0.102");
    expect(model.rows.find((row) => row.label === "SL trigger")?.value).toBe("0.07");
    expect(model.rows.find((row) => row.label === "Tier open")?.value).toBe("10 AIOT");
  });

  it("labels the shared position apart from the tier and shows a flat external close", () => {
    const shared = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        config: { mode: "UP_TO", limit_price: 0.1, total_amount: 1000, size_unit: "QUOTE", duration: "1h", group_id: "tier-a" },
        custom_info: {
          exit_state: "ARMED",
          open_base: "400",
          exchange_position_base: "900",
          sibling_base: "500",
        },
      }),
    );
    expect(shared.rows.find((row) => row.label === "Position (shared)")?.value).toBe("900 AIOT");
    expect(shared.rows.find((row) => row.label === "Tier open")?.value).toBe("400 AIOT");
    expect(shared.rows.find((row) => row.label === "Group")?.value).toBe("tier-a");
    expect(shared.rows.find((row) => row.label === "Sibling base")?.value).toBe("500 AIOT");
    expect(rangeIcebergTierLine(executor({
      config: { mode: "UP_TO", limit_price: 0.1, total_amount: 1000, size_unit: "QUOTE", duration: "1h", group_id: "tier-a" },
      custom_info: { sibling_base: "500" },
    }))).toBe("0.1 · 1,000 USDT · 1h · tier-a · 500 AIOT");

    const flat = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: {
          exit_state: "DONE",
          open_base: "12",
          exchange_position_base: "12",
          external_close: true,
          reconcile_error: "position read failed",
        },
      }),
    );
    expect(flat.rows.find((row) => row.label === "Position (shared)")?.value).toBe("flat");
    expect(flat.rows.find((row) => row.label === "Tier open")?.value).toBe("12 AIOT");
    expect(flat.rows.find((row) => row.label === "Reconcile error")?.value).toBe("position read failed");
  });

  it("warns when the exchange stop was not placed, and prefers has_exchange_stop", () => {
    const failed = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: {
          exchange_stop_error: "MEXC rejected the stop: insufficient margin",
          exchange_stop_order_id: "stop-should-not-show",
        },
      }),
    );
    expect(failed.warnings).toEqual([
      { title: "Exchange stop is not placed", detail: "MEXC rejected the stop: insufficient margin" },
    ]);
    expect(failed.rows.find((row) => row.label === "Exchange stop")).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain("stop-should-not-show");

    const flagged = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: { has_exchange_stop: true },
      }),
    );
    expect(flagged.rows.find((row) => row.label === "Exchange stop")?.value).toBe("In place");
    expect(flagged.warnings).toEqual([]);

    const cleared = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: { has_exchange_stop: false, exchange_stop_order_id: "still-there" },
      }),
    );
    expect(cleared.rows.find((row) => row.label === "Exchange stop")).toBeUndefined();
    expect(JSON.stringify(cleared)).not.toContain("still-there");
  });

  it("reads a resume failure and a live stop on a position hold from custom_info or the record", () => {
    const resumed = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: { resume_failed: true, resume_error: "connector offline" },
      }),
    );
    expect(resumed.warnings).toEqual([{ title: "Resume failed", detail: "connector offline" }]);

    const held = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        close_type: "POSITION_HOLD",
        custom_info: { has_exchange_stop: "true" },
      }),
    );
    expect(held.rows.find((row) => row.label === "Exchange stop")?.value).toBe("In place");
    expect(held.warnings).toEqual([{ title: "The exchange stop is still on MEXC.", detail: "" }]);

    const fromRecord = executorHoverModel({
      ...executor({ timestamp: 0, pnl: 0, close_type: "position_hold", custom_info: {} }),
      has_exchange_stop: true,
      resume_failed: true,
      resume_error: "state restore failed",
    } as ExecutorInfo);
    expect(fromRecord.rows.find((row) => row.label === "Exchange stop")?.value).toBe("In place");
    expect(fromRecord.warnings).toEqual([
      { title: "Resume failed", detail: "state restore failed" },
      { title: "The exchange stop is still on MEXC.", detail: "" },
    ]);

    const flat = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        close_type: "POSITION_HOLD",
        custom_info: { has_exchange_stop: false },
      }),
    );
    expect(flat.warnings).toEqual([]);
    expect(flat.rows.find((row) => row.label === "Exchange stop")).toBeUndefined();
  });

  it("shows a pending config edit and a config edit error when the executor sends them", () => {
    const pending = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: { pending_config_edit: { total_amount: "150", stop_loss: null } },
      }),
    );
    expect(pending.warnings).toEqual([
      { title: "Config edit pending", detail: "total_amount, stop_loss" },
    ]);

    const failed = executorHoverModel(
      executor({
        timestamp: 0,
        pnl: 0,
        custom_info: { config_edit_error: "cannot shrink total_amount below the filled amount" },
      }),
    );
    expect(failed.warnings).toEqual([
      {
        title: "Config edit failed",
        detail: "cannot shrink total_amount below the filled amount",
      },
    ]);

    const quiet = executorHoverModel(executor({ timestamp: 0, pnl: 0, custom_info: {} }));
    expect(quiet.warnings).toEqual([]);
    expect(quiet.notes).toEqual([]);
  });

  it("shows a config edit note as info, beside a failure when both are present", () => {
    const noted = executor({
      timestamp: 0,
      pnl: 0,
      custom_info: {
        config_edit_note: "total amount was clamped to the filled amount",
        config_edit_error: "stop loss was not applied",
        pending_config_edit: true,
      },
    });
    const model = executorHoverModel(noted);
    expect(model.notes).toEqual([
      { title: "Config edit", detail: "total amount was clamped to the filled amount" },
    ]);
    expect(model.warnings).toEqual([
      { title: "Config edit failed", detail: "stop loss was not applied" },
      { title: "Config edit pending", detail: "" },
    ]);
    expect(executorRunDetail(noted)).toMatchObject({
      configEditNote: "total amount was clamped to the filled amount",
      configEditError: "stop loss was not applied",
      configEditPending: true,
    });
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
