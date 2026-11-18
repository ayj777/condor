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
import { ORDER_DEFAULTS, type OrderAction, type OrderState } from "./order-config";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let dispatched: OrderAction[];

function render(patch: Partial<OrderState> = {}) {
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
    expect(text).toContain("Long 0.0816, short 0.0784, from limit 0.08.");
    expect(text).toContain("Long 0.0792, short 0.0808, from limit 0.08.");
    expect(container.querySelector('button[aria-label="Order type"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop loss close"]')?.textContent).toContain("Iceberg");
    expect(text).toContain("Slices");
    expect(container.querySelector('input[placeholder="30s, empty sends all at once"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop loss prices"]')?.textContent).toContain("Up to");
  });

  it("tells the user a single stop loss is a market order", () => {
    render({ ri_sl_enabled: true, ri_sl_execution: "SINGLE" });
    expect(container.textContent).toContain("A single stop loss sends a market order.");
    expect(container.querySelector('button[aria-label="Order type"]')).toBeNull();
  });
});
