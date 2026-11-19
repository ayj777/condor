/**
 * Executor list status badges: a live row is a green pill, every other
 * status is the same pill in red. A deeper-tier pause keeps its yellow badge.
 *
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutorInfo } from "@/lib/api";
import { TradeBottomPane } from "./TradeBottomPane";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

function executor(patch: Partial<ExecutorInfo>): ExecutorInfo {
  return {
    id: patch.id ?? "ex-1",
    type: "position_executor",
    connector: "binance_perpetual",
    trading_pair: "BTC-USDT",
    side: "BUY",
    status: "failed",
    close_type: "",
    pnl: 0,
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

function render(executors: ExecutorInfo[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <TradeBottomPane
          executors={executors}
          positions={[]}
          isLoadingPositions={false}
          connector="binance_perpetual"
          pair="BTC-USDT"
          isSpot={false}
        />
      </QueryClientProvider>,
    );
  });
}

function badge(text: string): HTMLElement {
  const match = [...container.querySelectorAll("span")].find((node) => node.textContent === text);
  if (!match) throw new Error(`no badge with text ${text}`);
  return match as HTMLElement;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem("condor_trade_bottom_pane", "1");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("executor status badges", () => {
  it("paints every inactive status as a red pill and leaves Active and Paused alone", () => {
    render([
      executor({ id: "live", status: "running" }),
      executor({ id: "halted", status: "active", custom_info: { unknown_order_halt: true, status_reason: "unknown order" } }),
      executor({
        id: "paused-tier",
        status: "running",
        custom_info: { entry_paused: true, pause_reason: "deeper tier active" },
      }),
      executor({ id: "failed", status: "failed" }),
      executor({ id: "stopped", status: "stopped" }),
      executor({ id: "terminated", status: "terminated" }),
      executor({ id: "expired", status: "expired" }),
      executor({ id: "completed", status: "completed", close_type: "TAKE_PROFIT" }),
    ]);

    const active = badge("ACTIVE");
    expect(active.className).toContain("bg-[var(--color-green)]/15");
    expect(active.className).toContain("text-[var(--color-green)]");
    expect(active.querySelector(".animate-pulse")).not.toBeNull();

    const halt = badge("PAUSED");
    expect(halt.className).toContain("text-[var(--color-green)]");
    expect(halt.className).not.toContain("color-red");

    const paused = badge("Paused");
    expect(paused.className).toContain("bg-[var(--color-yellow)]/15");
    expect(paused.className).toContain("text-[var(--color-yellow)]");
    expect(paused.className).not.toContain("color-red");

    for (const label of ["failed", "stopped", "terminated", "expired", "TAKE PROFIT"]) {
      const node = badge(label);
      expect(node.className).toContain("rounded-full");
      expect(node.className).toContain("border-[var(--color-red)]/50");
      expect(node.className).toContain("bg-[var(--color-red)]/15");
      expect(node.className).toContain("text-[var(--color-red)]");
      expect(node.className).not.toContain("color-text-muted");
      expect(node.className).not.toContain("color-green");
    }
  });
});
