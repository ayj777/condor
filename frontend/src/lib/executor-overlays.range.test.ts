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
    expect(html).toContain("Range iceberg");
    expect(html).not.toContain("RANGE_ICEBERG");
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
    expect(overlay.type).toBe("range_iceberg");
    expect(overlay.typeLabel).toBe("Limit iceberg");
    expect(overlay.gridBox).toBeUndefined();
    expect(overlay.priceLines[0]?.price).toBe(0.08137);
    expect(overlay.priceLines[0]?.label).toBe("Limit iceberg");
    const html = renderOverlayTooltipHtml(overlay, {
      formatValue: (n) => String(n),
      formatPnl: (n) => String(n),
    });
    expect(html).toContain("Limit iceberg");
    expect(html).not.toContain("Range iceberg");
    expect(html).toContain("0.08137");
    expect(executorTypeLabel(executor({
      custom_info: { mode: "up to" },
      config: { mode: "RANGE" },
    }))).toBe("Limit iceberg");
    const tiered = renderOverlayTooltipHtml(
      computeExecutorOverlay(executor({
        custom_info: { mode: "UP_TO", sibling_base: 2500 },
        config: {
          mode: "UP_TO",
          limit_price: 0.09,
          total_amount: 2000,
          size_unit: "QUOTE",
          duration: "1h",
          group_id: "tier-b",
        },
      })),
      { formatValue: (n) => String(n), formatPnl: (n) => String(n) },
    );
    expect(tiered).toContain("0.09");
    expect(tiered).toContain("2,000 USDT");
    expect(tiered).toContain("1h");
    expect(tiered).toContain("tier-b");
    expect(tiered).toContain("2,500 AIOT");
    const paused = renderOverlayTooltipHtml(
      computeExecutorOverlay(executor({
        custom_info: { mode: "UP_TO", entry_paused: true, pause_reason: "deeper tier active" },
        config: { mode: "UP_TO", limit_price: 0.1, take_profit: { percent: "0.02" }, stop_loss: { price: "0.07" } },
      })),
      { formatValue: (n) => String(n), formatPnl: (n) => String(n) },
    );
    expect(paused).toContain("Paused");
    expect(paused).toContain("deeper tier active");
    expect(paused).toContain("TP and SL active");
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
