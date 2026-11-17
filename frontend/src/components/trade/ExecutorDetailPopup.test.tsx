/**
 * Keyboard focus opens the same order card as hover.
 *
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutorInfo } from "@/lib/api";
import { ExecutorHoverRow } from "@/components/trade/ExecutorDetailPopup";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const executor: ExecutorInfo = {
  id: "ri-focus",
  type: "range_iceberg_executor",
  connector: "mexc_perpetual",
  trading_pair: "AIOT-USDT",
  side: "BUY",
  status: "running",
  close_type: "EARLY_STOP",
  pnl: 0.75,
  volume: 0,
  timestamp: 1_700_000_000,
  controller_id: "main",
  cum_fees_quote: 0,
  net_pnl_pct: 0,
  entry_price: 0,
  current_price: 0,
  close_timestamp: 0,
  config: {
    mode: "UP_TO",
    position_side: "LONG",
    margin_mode: "ISOLATED",
    leverage: 1,
    total_amount: 30000,
  },
  custom_info: {
    status_reason: "Cancel was not confirmed on the exchange",
    open_orders: [{ price: 0.081, amount: 100, exchange_order_id: "ex-9", status: "OPEN" }],
  },
};

let container: HTMLDivElement;
let root: Root;

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

function renderRow() {
  act(() => {
    root.render(
      <table>
        <tbody>
          <ExecutorHoverRow executor={executor}>
            <td>AIOT</td>
          </ExecutorHoverRow>
        </tbody>
      </table>,
    );
  });
}

const row = () => container.querySelector("tr")!;
const card = () => document.querySelector("[data-executor-detail='ri-focus']");

describe("executor row focus", () => {
  it("shows the order card on focus and hides it on Escape", () => {
    renderRow();
    expect(card()).toBeNull();

    act(() => {
      row().focus();
    });

    const open = card();
    expect(open?.textContent).toContain("Range iceberg");
    expect(open?.textContent).toContain("Up to");
    expect(open?.textContent).toContain("OPEN");
    expect(open?.textContent).not.toContain("ISOLATED");
    expect(open?.textContent).not.toContain("1x");
    expect(open?.textContent).not.toContain("ex-9");
    expect(open?.textContent).not.toContain("PnL");
    expect(open?.textContent).toContain("Cancel was not confirmed on the exchange");
    expect(row().getAttribute("aria-describedby")).toBe("executor-detail-ri-focus");

    act(() => {
      row().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(card()).toBeNull();
  });
});
