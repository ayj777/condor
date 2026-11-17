import type { ExecutorInfo } from "@/lib/api";
import { isExecutorActive } from "@/lib/formatters";

const STRATEGY_LABELS: Record<string, string> = {
  LIMIT: "Limit",
  LIMIT_CHASER: "Chaser",
  MARKET: "Market",
  TWAP: "TWAP",
};

export function executorTypeLabel(ex: ExecutorInfo): string {
  const strategy = String(ex.config?.execution_strategy ?? "").toUpperCase();
  if (strategy && STRATEGY_LABELS[strategy]) return STRATEGY_LABELS[strategy];
  const type = (ex.type || "").toLowerCase();
  if (type.includes("range_iceberg")) return "Range iceberg";
  return ex.type ? ex.type.charAt(0).toUpperCase() + ex.type.slice(1) : "—";
}

/** Filled size, halt reason, and whether resume is meaningful for this row. */
export function executorRunDetail(ex: ExecutorInfo): {
  filled: string | null;
  halt: string | null;
  canResume: boolean;
} {
  const info = ex.custom_info || {};
  const filled = Number(info.filled_amount);
  const total = Number(info.target_amount ?? ex.config?.total_amount);
  const filledText =
    Number.isFinite(filled) && filled > 0
      ? Number.isFinite(total) && total > 0
        ? `${filled} / ${total}`
        : String(filled)
      : null;
  const halted = info.unknown_order_halt === true;
  const reason = typeof info.status_reason === "string" ? info.status_reason : "";
  const halt = halted ? reason || "unknown_order_halt" : null;
  const paused = info.paused === true || halted;
  return { filled: filledText, halt, canResume: paused && isExecutorActive(ex.status) };
}
