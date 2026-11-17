import type { ExecutorInfo } from "@/lib/api";
import { isExecutorActive } from "@/lib/formatters";

const STRATEGY_LABELS: Record<string, string> = {
  LIMIT: "Limit",
  LIMIT_CHASER: "Chaser",
  MARKET: "Market",
  TWAP: "TWAP",
};

/** `UP_TO`, `up-to`, and `up to` are the same mode. Anything else is a range. */
export function rangeIcebergMode(source: {
  config?: Record<string, unknown> | null;
  custom_info?: Record<string, unknown> | null;
}): string {
  const info = source.custom_info ?? {};
  const cfg = source.config ?? {};
  const raw = info.mode ?? cfg.mode ?? "RANGE";
  return String(raw).trim().replace(/[\s-]+/g, "_").toUpperCase();
}

export function executorTypeLabel(ex: ExecutorInfo): string {
  const type = (ex.type || "").toLowerCase();
  if (type.includes("range_iceberg")) {
    return rangeIcebergMode(ex) === "UP_TO" ? "Limit iceberg" : "Range iceberg";
  }
  const strategy = String(ex.config?.execution_strategy ?? "").toUpperCase();
  if (strategy && STRATEGY_LABELS[strategy]) return STRATEGY_LABELS[strategy];
  return ex.type ? ex.type.charAt(0).toUpperCase() + ex.type.slice(1) : "—";
}

/**
 * The type string a list shows.
 *
 * A range iceberg is named for its mode. Every other type stays the raw value
 * the row already showed.
 */
export function displayedExecutorType(ex: ExecutorInfo): string {
  if ((ex.type || "").toLowerCase().includes("range_iceberg")) return executorTypeLabel(ex);
  return ex.type || "—";
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

/** Resting child order ids, shown next to a halt. */
export function childOrderIds(ex: { custom_info?: Record<string, unknown> } | null | undefined): string[] {
  const info = ex?.custom_info || {};
  const ids: string[] = [];
  const levels = info.levels;
  if (Array.isArray(levels)) {
    for (const level of levels) {
      if (!level || typeof level !== "object") continue;
      const row = level as Record<string, unknown>;
      const id = row.order_id || row.client_order_id;
      if (id) ids.push(String(id));
    }
  }
  const extra = info.child_order_ids;
  if (Array.isArray(extra)) {
    for (const id of extra) {
      if (id) ids.push(String(id));
    }
  }
  return ids;
}
