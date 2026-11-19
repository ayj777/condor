/**
 * Quote is the default size. A saved base unit from before that default loads
 * as quote, and an explicit base choice made after the change is kept.
 *
 * @vitest-environment jsdom
 */

import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ORDER_DEFAULTS_KEY } from "@/lib/sessionState";

import { ORDER_DEFAULTS, ORDER_SIZE_UNIT_VERSION, useOrderConfig } from "./order-config";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

type OrderConfig = ReturnType<typeof useOrderConfig>;

let container: HTMLDivElement;
let root: Root;
let latest: OrderConfig;

function Probe({
  mid = null,
  rule = null,
}: {
  mid?: number | null;
  rule?: { minOrderSize: number; increment: number } | null;
}) {
  const config = useOrderConfig(rule, "AIOT", "USDT", mid);
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

function render(node: ReactNode = <Probe />) {
  act(() => {
    root.render(node);
  });
}

describe("quote size default", () => {
  it("starts a new form in quote", () => {
    expect(ORDER_DEFAULTS.ri_size_unit).toBe("QUOTE");
    expect(ORDER_DEFAULTS.amount_unit).toBe("QUOTE");
    render();
    expect(latest.state.ri_size_unit).toBe("QUOTE");
    expect(latest.state.amount_unit).toBe("QUOTE");
    const saved = JSON.parse(localStorage.getItem(ORDER_DEFAULTS_KEY) ?? "{}");
    expect(saved.size_unit_version).toBe(ORDER_SIZE_UNIT_VERSION);
    expect(saved.ri_size_unit).toBe("QUOTE");
  });

  it("reads a pre-quote saved BASE as quote", () => {
    localStorage.setItem(ORDER_DEFAULTS_KEY, JSON.stringify({
      ri_size_unit: "BASE",
      amount_unit: "BASE",
      amount: 25,
      side: 2,
    }));
    render();
    expect(latest.state.ri_size_unit).toBe("QUOTE");
    expect(latest.state.amount_unit).toBe("QUOTE");
    expect(latest.state.amount).toBe(25);
    expect(latest.state.side).toBe(2);
  });

  it("keeps an explicit base choice saved after quote became the default", () => {
    localStorage.setItem(ORDER_DEFAULTS_KEY, JSON.stringify({
      size_unit_version: ORDER_SIZE_UNIT_VERSION,
      ri_size_unit: "BASE",
      amount_unit: "BASE",
      amount: 40,
    }));
    render();
    expect(latest.state.ri_size_unit).toBe("BASE");
    expect(latest.state.amount_unit).toBe("BASE");
    expect(latest.state.amount).toBe(40);
  });

  it("converts a quote order to base and blocks a quote order with no price", () => {
    render(<Probe mid={0.08} rule={{ minOrderSize: 10, increment: 10 }} />);
    act(() => {
      latest.dispatch({ type: "SET_FIELD", field: "execution_strategy", value: "MARKET" });
      latest.dispatch({ type: "SET_FIELD", field: "amount", value: 80 });
    });
    expect(latest.validation.valid).toBe(true);
    expect(latest.buildPayload("mexc", "AIOT-USDT", true).config.amount).toBe(1000);

    act(() => {
      latest.dispatch({ type: "SET_FIELD", field: "execution_strategy", value: "LIMIT" });
      latest.dispatch({ type: "SET_FIELD", field: "price", value: 0 });
    });
    expect(latest.validation.valid).toBe(false);
    expect(latest.validation.errors[0]).toMatch(/price is required/i);
    expect(() => latest.buildPayload("mexc", "AIOT-USDT", true)).toThrow(/price is required/i);
  });
});

describe("schedule interval defaults", () => {
  it("turns a saved slice count into an interval and drops the slice field", () => {
    localStorage.setItem(ORDER_DEFAULTS_KEY, JSON.stringify({
      size_unit_version: ORDER_SIZE_UNIT_VERSION,
      ri_duration: "10m",
      ri_schedule_slices: 5,
      ri_schedule_interval: "",
      ri_size_unit: "QUOTE",
    }));
    render();
    expect(latest.state.ri_schedule_interval).toBe("2m");
    expect(latest.state).not.toHaveProperty("ri_schedule_slices");
    const saved = JSON.parse(localStorage.getItem(ORDER_DEFAULTS_KEY) ?? "{}") as Record<string, unknown>;
    expect(saved.ri_schedule_interval).toBe("2m");
    expect(saved).not.toHaveProperty("ri_schedule_slices");
  });

  it("keeps a saved interval when an old slice count is also present", () => {
    localStorage.setItem(ORDER_DEFAULTS_KEY, JSON.stringify({
      size_unit_version: ORDER_SIZE_UNIT_VERSION,
      ri_duration: "10m",
      ri_schedule_slices: 5,
      ri_schedule_interval: "30s",
    }));
    render();
    expect(latest.state.ri_schedule_interval).toBe("30s");
    const saved = JSON.parse(localStorage.getItem(ORDER_DEFAULTS_KEY) ?? "{}") as Record<string, unknown>;
    expect(saved.ri_schedule_interval).toBe("30s");
    expect(saved).not.toHaveProperty("ri_schedule_slices");
  });

  it("sends schedule_interval and never schedule_slices", () => {
    render();
    act(() => {
      latest.dispatch({ type: "SET_FIELD", field: "execution_strategy", value: "RANGE_ICEBERG" });
      latest.dispatch({ type: "SET_FIELD", field: "ri_mode", value: "UP_TO" });
      latest.dispatch({ type: "SET_FIELD", field: "ri_limit_price", value: 0.08 });
      latest.dispatch({ type: "SET_FIELD", field: "ri_total_amount", value: 100 });
      latest.dispatch({ type: "SET_FIELD", field: "ri_size_unit", value: "BASE" });
      latest.dispatch({ type: "SET_FIELD", field: "ri_duration", value: "10m" });
      latest.dispatch({ type: "SET_FIELD", field: "ri_schedule_interval", value: "2m" });
    });
    const config = latest.buildPayload("mexc", "AIOT-USDT", true).config;
    expect(config.duration).toBe("10m");
    expect(config.schedule_interval).toBe("2m");
    expect(config).not.toHaveProperty("schedule_slices");
  });
});
