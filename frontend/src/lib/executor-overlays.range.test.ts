// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { ExecutorInfo } from "./api";
import { computeExecutorOverlay, renderOverlayTooltipHtml } from "./executor-overlays";
import { executorRunDetail, executorTypeLabel } from "@/lib/executor-run";

function executor(patch: Partial<ExecutorInfo> = {}): ExecutorInfo {
  return {
    id: "ri-1",
    type: "range_iceberg_executor",
    connector: "mexc_perpetual",
    trading_pair: "AIOT-USDT",
    side: "BUY",
    status: "running",
    close_type: "",
    pnl: 0,
    volume: 0,
    timestamp: 1_700_000_000,
    controller_id: "main",
    cum_fees_quote: 0,
    net_pnl_pct: 0,
    entry_price: 0,
    current_price: 0,
    close_timestamp: 1_700_003_600,
    custom_info: {
      filled_amount: 20,
      target_amount: 100,
      unknown_order_halt: true,
      status_reason: "unknown_order_halt: abc",
      paused: true,
      mode: "RANGE",
    },
    config: {
      price_low: 0.07,
      price_high: 0.09,
      total_amount: 100,
      margin_mode: "ISOLATED",
    },
    ...patch,
  };
}

describe("range iceberg on the chart and the bottom pane", () => {
  it("draws the range as a box and names the halt in the tooltip", () => {
    const overlay = computeExecutorOverlay(executor());
    expect(overlay.type).toBe("range_iceberg");
    expect(overlay.gridBox?.startPrice).toBe(0.09);
    expect(overlay.gridBox?.endPrice).toBe(0.07);
    const html = renderOverlayTooltipHtml(overlay, {
      formatValue: (n) => String(n),
      formatPnl: (n) => String(n),
    });
    expect(html).toContain("unknown_order_halt: abc");
    expect(html).toContain("20 / 100");
  });

  it("draws an up-to order as a limit line", () => {
    const overlay = computeExecutorOverlay(
      executor({
        custom_info: { mode: "UP_TO" },
        config: { mode: "UP_TO", limit_price: 0.08137 },
      }),
    );
    expect(overlay.gridBox).toBeUndefined();
    expect(overlay.priceLines[0]?.price).toBe(0.08137);
  });

  it("labels the row and offers resume while the halt is set", () => {
    const ex = executor();
    expect(executorTypeLabel(ex)).toBe("Range iceberg");
    expect(executorRunDetail(ex)).toMatchObject({
      filled: "20 / 100",
      halt: "unknown_order_halt: abc",
      canResume: true,
    });
  });
});
