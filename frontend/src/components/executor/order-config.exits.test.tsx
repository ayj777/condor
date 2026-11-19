/**
 * The order form's create payload carries take profit and stop loss only when
 * the toggles are on, and a close (reduce only) cannot arm either exit.
 *
 * @vitest-environment jsdom
 */

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ORDER_DEFAULTS, orderReducer, useOrderConfig } from "./order-config";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

type OrderConfig = ReturnType<typeof useOrderConfig>;

let container: HTMLDivElement;
let root: Root;
let latest: OrderConfig;

function Probe() {
  const config = useOrderConfig();
  useEffect(() => {
    latest = config;
  });
  return null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

function setField(field: string, value: unknown) {
  act(() => {
    latest.dispatch({ type: "SET_FIELD", field, value });
  });
}

describe("order config exits", () => {
  it("omits exits until one is enabled, then sends the armed config", () => {
    setField("execution_strategy", "RANGE_ICEBERG");
    setField("ri_mode", "UP_TO");
    setField("ri_limit_price", 0.08);
    setField("ri_total_amount", 100);
    setField("ri_duration", "");
    const off = latest.buildPayload("mexc_perpetual", "AIOT-USDT", true);
    expect(off.config.take_profit).toBeUndefined();
    expect(off.config.stop_loss).toBeUndefined();
    expect(off.config.exit_arming).toBeUndefined();
    expect(latest.validation.valid).toBe(true);

    setField("ri_tp_enabled", true);
    setField("ri_tp_percent", 0.02);
    setField("ri_sl_enabled", true);
    setField("ri_sl_percent", 0.01);
    setField("ri_sl_execution", "ICEBERG");
    setField("ri_sl_slices", 4);
    setField("ri_sl_visible_count", 1);
    setField("ri_sl_interval", "30s");
    setField("ri_sl_price_style", "LIMIT");
    setField("ri_sl_limit_price", 0.07);
    setField("ri_exit_arming", "ON_ANY_FILL");

    setField("ri_cap_behavior", "WAIT");
    expect(latest.validation.valid).toBe(true);
    expect(latest.buildPayload("mexc_perpetual", "AIOT-USDT", true).config).toMatchObject({
      cap_behavior: "WAIT",
      exit_arming: "ON_ANY_FILL",
      take_profit: { percent: "0.02", execution: "SINGLE", order_type: "LIMIT" },
      stop_loss: {
        percent: "0.01",
        execution: "ICEBERG",
        slices: 4,
        visible_count: 1,
        interval: "30s",
        limit_price: "0.07",
        cap_behavior: "REST_AT_CAP",
      },
    });
  });

  it("rejects a long stop loss iceberg whose limit sits above the trigger", () => {
    setField("execution_strategy", "RANGE_ICEBERG");
    setField("ri_mode", "UP_TO");
    setField("ri_limit_price", 0.08);
    setField("ri_total_amount", 100);
    setField("ri_duration", "");
    setField("ri_sl_enabled", true);
    setField("ri_sl_percent", 0.01);
    setField("ri_sl_execution", "ICEBERG");
    setField("ri_sl_slices", 2);
    setField("ri_sl_visible_count", 1);
    setField("ri_sl_price_style", "LIMIT");
    setField("ri_sl_limit_price", 0.09);
    expect(latest.validation.valid).toBe(false);
    expect(latest.validation.errors.join(" ")).toMatch(/at or below the trigger for a long/);
  });

  it("blocks a reduce-only close that also sets an exit", () => {
    setField("execution_strategy", "RANGE_ICEBERG");
    setField("ri_mode", "UP_TO");
    setField("ri_limit_price", 0.08);
    setField("ri_total_amount", 100);
    setField("ri_duration", "");
    setField("position_action", "CLOSE");
    setField("ri_tp_enabled", true);
    setField("ri_tp_percent", 0.02);
    expect(latest.validation.valid).toBe(false);
    expect(latest.validation.errors.join(" ")).toMatch(/reduce only/);
  });

  it("drops exit prices when the market changes", () => {
    const priced = {
      ...ORDER_DEFAULTS,
      ri_tp_price: 0.09,
      ri_tp_limit_price: 0.1,
      ri_sl_price_low: 0.05,
      ri_sl_price_high: 0.06,
      ri_tp_percent: 0.02,
    };
    const moved = orderReducer(priced, { type: "SET_PAIR", value: "ETH-USDT" });
    expect(moved.ri_tp_price).toBe(0);
    expect(moved.ri_tp_limit_price).toBe(0);
    expect(moved.ri_sl_price_low).toBe(0);
    expect(moved.ri_sl_price_high).toBe(0);
    expect(moved.ri_tp_percent).toBe(0.02);
  });
});
