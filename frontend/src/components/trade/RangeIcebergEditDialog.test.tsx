/**
 * The range iceberg edit form: prefilled exits, a shrink check, and the
 * trading API's rejection text.
 *
 * @vitest-environment jsdom
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutorInfo } from "@/lib/api";

import { RangeIcebergEditDialog } from "./RangeIcebergEditDialog";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

function executor(patch: Partial<ExecutorInfo> = {}): ExecutorInfo {
  return {
    id: "ri-edit",
    type: "range_iceberg_executor",
    connector: "mexc_perpetual",
    trading_pair: "AIOT-USDT",
    side: "BUY",
    status: "running",
    close_type: "",
    pnl: 0,
    volume: 0,
    timestamp: 0,
    controller_id: "main",
    cum_fees_quote: 0,
    net_pnl_pct: 0,
    entry_price: 0.08,
    current_price: 0.08,
    close_timestamp: 0,
    custom_info: { filled_base: 40 },
    config: {
      mode: "RANGE",
      total_amount: 100,
      price_low: 0.07,
      price_high: 0.09,
      limit_price: 0,
    },
    ...patch,
  };
}

function render(node: ReactNode) {
  act(() => {
    root.render(node);
  });
}

function setInput(label: string, value: string) {
  const match = [...container.querySelectorAll("label")].find((el) => el.textContent?.includes(label));
  const id = match?.getAttribute("for");
  const input = id ? container.querySelector(`#${CSS.escape(id)}`) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`missing ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(name: string) {
  const button = [...container.querySelectorAll("button")].find((el) => el.textContent === name);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${name}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("range iceberg edit dialog", () => {
  it("shows the filled amount, the range, and the exit editors", () => {
    render(
      <RangeIcebergEditDialog
        executor={executor()}
        pending={false}
        error={null}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(container.textContent).toContain("Filled 40");
    expect(container.textContent).toContain("Price low");
    expect(container.textContent).toContain("Price high");
    expect(container.textContent).toContain("Take profit");
    expect(container.textContent).toContain("Stop loss");
  });

  it("hides price bounds on an up-to iceberg", () => {
    render(
      <RangeIcebergEditDialog
        executor={executor({
          config: { mode: "UP_TO", total_amount: 100, limit_price: 0.08 },
        })}
        pending={false}
        error={null}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(container.textContent).toContain("limit iceberg");
    expect(container.textContent).not.toContain("Price low");
    expect(container.textContent).not.toContain("Price high");
  });

  it("blocks a total below the fill and does not submit", () => {
    const submitted: Record<string, unknown>[] = [];
    render(
      <RangeIcebergEditDialog
        executor={executor({
          config: {
            mode: "RANGE",
            size_unit: "BASE",
            total_amount: 100,
            price_low: 0.07,
            price_high: 0.09,
          },
        })}
        pending={false}
        error={null}
        onClose={() => {}}
        onSubmit={(body) => submitted.push(body)}
      />,
    );
    setInput("Total amount", "10");
    click("Save");
    expect(container.textContent).toContain("Total amount cannot be below the filled amount");
    expect(container.textContent).toContain("approx 0.8 USDT");
    expect(submitted).toEqual([]);
  });

  it("does not block a quote total when only the base fill is known", () => {
    const submitted: Record<string, unknown>[] = [];
    render(
      <RangeIcebergEditDialog
        executor={executor()}
        pending={false}
        error={null}
        onClose={() => {}}
        onSubmit={(body) => submitted.push(body)}
      />,
    );
    expect(container.textContent).toContain("Total amount (USDT)");
    expect(container.textContent).toContain("Filled 40 AIOT");
    expect(container.textContent).toContain("approx 3.2 USDT");
    setInput("Total amount", "10");
    click("Save");
    expect(container.textContent).not.toContain("cannot be below the filled amount");
    expect(submitted).toEqual([{ total_amount: 10 }]);
  });

  it("submits only the changed total", () => {
    const submitted: Record<string, unknown>[] = [];
    render(
      <RangeIcebergEditDialog
        executor={executor()}
        pending={false}
        error={null}
        onClose={() => {}}
        onSubmit={(body) => submitted.push(body)}
      />,
    );
    setInput("Total amount", "150");
    click("Save");
    expect(submitted).toEqual([{ total_amount: 150 }]);
  });

  it("shows frozen settings and blocks a total below the live slice", () => {
    const submitted: Record<string, unknown>[] = [];
    render(
      <RangeIcebergEditDialog
        executor={executor({
          config: {
            mode: "RANGE",
            total_amount: 100,
            size_unit: "QUOTE",
            price_low: 0.07,
            price_high: 0.09,
            duration: "10m",
            schedule_interval: "2m",
            schedule_start: "SUBMIT",
            levels: 4,
            iceberg: true,
            visible_count: 2,
            slice_amount: 30,
            leverage: 20,
            margin_mode: "ISOLATED",
          },
        })}
        pending={false}
        error={null}
        onClose={() => {}}
        onSubmit={(body) => submitted.push(body)}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Schedule 10m every 2m, clock starts at submit");
    expect(text).toContain("4 price rungs");
    expect(text).toContain("Iceberg on, 2 visible");
    expect(text).toContain("Slice amount 30 USDT");
    expect(text).toContain("Leverage 20x");
    expect(text).toContain("Margin ISOLATED");
    setInput("Total amount", "20");
    click("Save");
    expect(text && container.textContent).toContain("cannot be below the live slice amount");
    expect(submitted).toEqual([]);
    setInput("Total amount", "80");
    click("Save");
    expect(submitted).toEqual([{ total_amount: 80 }]);
    expect(submitted[0]).not.toHaveProperty("leverage");
    expect(submitted[0]).not.toHaveProperty("duration");
    expect(submitted[0]).not.toHaveProperty("slice_amount");
  });

  it("shows the 409 reason in the error toast as the API sent it", () => {
    const error = "A range iceberg is already open on AIOT-USDT BUY for master_account (executor hidden-id). Close it first.";
    render(
      <RangeIcebergEditDialog
        executor={executor()}
        pending={false}
        error={error}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    const toast = container.querySelector(".text-\\[var\\(--color-red\\)\\]");
    expect(container.textContent).toContain(error);
    expect(container.textContent).not.toContain("LONG");
    expect(toast).not.toBeNull();
  });
});
