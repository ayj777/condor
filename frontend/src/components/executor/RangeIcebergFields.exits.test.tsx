/**
 * Take profit and stop loss on the range / limit iceberg form.
 *
 * Both start off, so a create that never opens them sends neither field.
 * Turning one on reveals the percent or price trigger, the long and short
 * preview, and the iceberg fields the entry form already uses.
 *
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RangeIcebergFields } from "./RangeIcebergFields";
import { OrderConfigPanel } from "./OrderConfigPanel";
import { ORDER_DEFAULTS, type OrderAction, type OrderState } from "./order-config";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let dispatched: OrderAction[];

function render(patch: Partial<OrderState> = {}, hedge = false) {
  const state: OrderState = {
    ...ORDER_DEFAULTS,
    execution_strategy: "RANGE_ICEBERG",
    ri_mode: "UP_TO",
    ri_limit_price: 0.08,
    ri_total_amount: 100,
    ...patch,
  };
  act(() => {
    root.render(
      <RangeIcebergFields
        state={state}
        dispatch={(action) => dispatched.push(action)}
        connector="mexc_perpetual"
        sizeRule={null}
        baseSymbol="AIOT"
        quoteSymbol="USDT"
        hedge={hedge}
      />,
    );
  });
}

function checkbox(label: string): HTMLInputElement {
  const match = [...container.querySelectorAll("label")].find((el) => el.textContent?.includes(label));
  const input = match?.querySelector("input[type='checkbox']");
  if (!(input instanceof HTMLInputElement)) throw new Error(`missing checkbox ${label}`);
  return input;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dispatched = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("range iceberg exits", () => {
  it("keeps take profit and stop loss off, with arming after a full fill", () => {
    render();
    expect(checkbox("Take profit").checked).toBe(false);
    expect(checkbox("Stop loss").checked).toBe(false);
    expect(container.textContent).toContain("After full fill");
    expect(container.textContent).toContain("a limit take profit rests and grows with fills");
    expect(container.textContent).toContain("A market or iceberg take profit cancels the remaining entry");
    expect(container.textContent).not.toContain("protect a partial fill");
    expect(container.textContent).not.toContain("Percent");
    expect(container.textContent).not.toContain("A single stop loss sends a market order.");
  });

  it("turns take profit on from the toggle", () => {
    render();
    act(() => checkbox("Take profit").click());
    expect(dispatched).toContainEqual({ type: "SET_FIELD", field: "ri_tp_enabled", value: true });
  });

  it("previews both sides and reuses the iceberg fields", () => {
    render({
      ri_tp_enabled: true,
      ri_tp_trigger: "percent",
      ri_tp_percent: 0.02,
      ri_tp_execution: "SINGLE",
      ri_tp_order_type: "LIMIT",
      ri_sl_enabled: true,
      ri_sl_trigger: "percent",
      ri_sl_percent: 0.01,
      ri_sl_execution: "ICEBERG",
      ri_sl_slices: 4,
      ri_sl_visible_count: 1,
      ri_sl_interval: "30s",
      ri_sl_price_style: "LIMIT",
      ri_sl_limit_price: 0.07,
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Estimate based on limit 0.08: long 0.0816, short 0.0784.");
    expect(text).toContain("Estimate based on limit 0.08: long 0.0792, short 0.0808.");
    expect(container.querySelector('button[aria-label="Order type"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop loss close"]')?.textContent).toContain("Iceberg");
    expect(text).toContain("Slices");
    expect(container.querySelector('input[placeholder="30s, empty sends all at once"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop loss prices"]')?.textContent).toContain("Up to");
  });

  it("shows the interval release under the interval field", () => {
    render({
      ri_duration: "1h",
      ri_schedule_interval: "10m",
      ri_total_amount: 300,
      ri_size_unit: "QUOTE",
      ri_catch_up: "CARRY",
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Schedule slices");
    expect(text).toContain("6 slices, about 50 USDT (\u2248 625 AIOT) every 10m");
    expect(text).toContain("a missed slice is placed later");
  });

  it("hides the release note when no duration is set", () => {
    render({ ri_duration: "", ri_schedule_interval: "10m", ri_total_amount: 300 });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Schedule slices");
    expect(text).not.toContain("every 10m");
    expect(text).toContain("all at once");
  });

  it("tells the user a single stop loss is a market order", () => {
    render({ ri_sl_enabled: true, ri_sl_execution: "SINGLE" });
    expect(container.textContent).toContain("A single stop loss sends a market order.");
    expect(container.querySelector('button[aria-label="Order type"]')).toBeNull();
  });

  it("has no iceberg checkbox and says one order fills before the next", () => {
    render({ ri_iceberg: false, ri_visible_count: 1, ri_duration: "10m", ri_schedule_interval: "1m" });
    const icebergBox = [...container.querySelectorAll("label")].find(
      (el) => el.querySelector("span")?.textContent === "Iceberg" && el.querySelector("input[type='checkbox']"),
    );
    expect(icebergBox).toBeUndefined();
    expect(container.textContent).toContain(
      "One order at a time. The next is placed after the previous one fills. A new share is released every 1m.",
    );
    expect(container.textContent).not.toContain("orders shown at once");
    const advanced = [...container.querySelectorAll("button")].find((el) => el.textContent === "Advanced");
    act(() => advanced?.click());
    expect(container.textContent).toContain("orders shown at once");
  });

  it("maps the Iceberg dropdown to that form and keeps a single control", () => {
    const state: OrderState = { ...ORDER_DEFAULTS, execution_strategy: "RANGE_ICEBERG" };
    act(() => {
      root.render(
        <OrderConfigPanel
          state={state}
          dispatch={(action) => dispatched.push(action)}
          validation={{ valid: true, errors: [] }}
          currentPrice={63790.4}
          connector="mexc_perpetual"
          pair="BTC-USDT"
          baseSymbol="BTC"
          quoteSymbol="USDT"
        />,
      );
    });
    const strategy = container.querySelector('button[aria-label="Execution Strategy"]');
    expect(strategy?.textContent).toContain("Iceberg");
    expect(strategy?.textContent).not.toContain("Range");
    const icebergBox = [...container.querySelectorAll("label")].find(
      (el) => el.querySelector("span")?.textContent === "Iceberg" && el.querySelector("input[type='checkbox']"),
    );
    expect(icebergBox).toBeUndefined();
    expect(container.textContent).toContain("One order at a time. The next is placed after the previous one fills.");
    act(() => (strategy as HTMLButtonElement).click());
    const options = [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent ?? "");
    expect(options.filter((label) => label.includes("Iceberg"))).toHaveLength(1);
    expect(options.some((label) => /ladder/i.test(label))).toBe(false);
  });

  it("shows schedule start and expiry only with the duration", () => {
    render({ ri_duration: "", ri_schedule_interval: "" });
    expect(container.textContent).toContain("Expiry, from submit");
    expect(container.textContent).not.toContain("Schedule start");
    expect(container.textContent).not.toContain("Catch up");
    render({ ri_duration: "10m", ri_schedule_interval: "2m", ri_schedule_start: "SUBMIT" });
    expect(container.textContent).toContain("Schedule start");
    expect(container.textContent).toContain("The clock starts when you submit");
    expect(container.textContent).toContain("Catch up");
  });

  it("hides the hedge reduce-only toggle", () => {
    render({ ri_mode: "UP_TO" }, true);
    expect(container.textContent).toContain("Open adds a position");
    expect(container.textContent).not.toContain("Reduce only");
  });

  it("hides distribution, weight, and max slippage on an up-to order", () => {
    render({ ri_mode: "UP_TO", ri_show_advanced: true });
    expect(container.textContent).not.toContain("Distribution");
    expect(container.textContent).not.toContain("Max slippage");
    expect(container.textContent).toContain("Repeats the jitter sequence");
  });

  it("labels weight and warns that a zero interval sends orders back to back", () => {
    render({
      ri_mode: "RANGE",
      ri_price_low: 0.07,
      ri_price_high: 0.09,
      ri_show_advanced: true,
      ri_min_order_interval: 0,
    });
    expect(container.textContent).toContain("more size at the high end");
    expect(container.textContent).toContain("0 sends orders back to back");
    expect(container.textContent).toContain("Exit orders are not post only");
  });

  it("shows the exchange stop and the 30s fallback", () => {
    render({
      ri_mode: "UP_TO",
      ri_limit_price: 0.08,
      ri_sl_enabled: true,
      ri_sl_trigger: "price",
      ri_sl_price: 0.07,
    });
    const text = container.textContent ?? "";
    expect(text).toContain("0.5% past this trigger");
    expect(text).toContain("30s");
    expect(text).toContain("cancels the remaining entry");
  });
});
