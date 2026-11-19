import type { ExecutorInfo } from "@/lib/api";
import { formatPriceSig, isExecutorActive } from "@/lib/formatters";
import {
  approximateQuoteLabel,
  formatTokenAmount,
  pairTokens,
  referenceSizePrice,
  sizeShownInBase,
  sizeUnitSymbol,
} from "@/lib/order-size";
import { formatInterval, parseDuration } from "@/lib/range-iceberg";

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

function tierNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tierPrice(value: number): string {
  const raw = formatPriceSig(value);
  if (!raw.includes(".")) return raw;
  return raw.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function tierText(value: unknown): string {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw || raw === "null" || raw === "undefined" || raw === "None") return "";
  return raw;
}

/**
 * The fields that tell one iceberg tier from another on the same pair and side.
 *
 * Group is omitted when the executor has none. Sibling base is omitted unless
 * `custom_info.sibling_base` is set.
 */
export function rangeIcebergTierFacts(ex: {
  type?: string;
  trading_pair?: string;
  config?: Record<string, unknown> | null;
  custom_info?: Record<string, unknown> | null;
}): { label: string; value: string }[] {
  if (!(ex.type || "").toLowerCase().includes("range_iceberg")) return [];
  const info = ex.custom_info ?? {};
  const cfg = ex.config ?? {};
  const rows: { label: string; value: string }[] = [];
  const mode = rangeIcebergMode(ex);
  if (mode === "UP_TO") {
    const limit = tierNumber(cfg.limit_price ?? info.limit_price);
    if (limit != null && limit > 0) rows.push({ label: "Limit", value: tierPrice(limit) });
  } else {
    const low = tierNumber(cfg.price_low ?? info.price_low);
    const high = tierNumber(cfg.price_high ?? info.price_high);
    if (low != null && high != null && low > 0 && high > 0) {
      rows.push({ label: "Range", value: `${tierPrice(low)} to ${tierPrice(high)}` });
    }
  }
  const total = tierNumber(cfg.total_amount ?? info.target_amount);
  if (total != null && total > 0) {
    const unit = sizeUnitSymbol(String(cfg.size_unit ?? info.size_unit ?? ""), ex.trading_pair);
    const text = formatTokenAmount(total);
    rows.push({ label: "Total", value: unit ? `${text} ${unit}` : text });
  }
  const duration = tierText(cfg.duration ?? info.duration);
  if (duration) {
    const seconds = parseDuration(duration);
    rows.push({ label: "Duration", value: seconds != null ? formatInterval(seconds) : duration });
  }
  const group = tierText(cfg.group_id ?? info.group_id);
  if (group) rows.push({ label: "Group", value: group });
  if (Object.prototype.hasOwnProperty.call(info, "sibling_base")) {
    const sibling = tierNumber(info.sibling_base);
    if (sibling != null) {
      const base = pairTokens(ex.trading_pair).base;
      const text = formatTokenAmount(sibling);
      rows.push({ label: "Sibling base", value: base ? `${text} ${base}` : text });
    }
  }
  return rows;
}

/** One line for the executor list. Empty for anything that is not a range iceberg. */
export function rangeIcebergTierLine(ex: ExecutorInfo): string {
  return rangeIcebergTierFacts(ex).map((row) => row.value).join(" · ");
}

function editText(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    return editText(row.message ?? row.error ?? row.detail ?? row.reason);
  }
  if (value == null) return "";
  const text = String(value).trim();
  if (!text || text === "null" || text === "undefined" || text === "None") return "";
  return text;
}

function editField(ex: ExecutorInfo, key: string): unknown {
  const info = ex.custom_info;
  if (info && Object.prototype.hasOwnProperty.call(info, key)) return info[key];
  const top = ex as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(top, key)) return top[key];
  return undefined;
}

/**
 * A queued in-place edit, a note about one that applied, and a failure.
 *
 * Absent fields stay quiet. `pending_config_edit` may be a flag or the
 * change object. `config_edit_note` is an applied edit with a caveat.
 * `config_edit_error` means the edit was not applied.
 */
export function executorConfigEdit(ex: ExecutorInfo | null | undefined): {
  pending: boolean;
  detail: string;
  error: string;
  note: string;
} {
  if (!ex) return { pending: false, detail: "", error: "", note: "" };
  const error = editText(editField(ex, "config_edit_error"));
  const note = editText(editField(ex, "config_edit_note"));
  const pendingRaw = editField(ex, "pending_config_edit");
  let pending = false;
  let detail = "";
  if (pendingRaw === true || pendingRaw === "true" || pendingRaw === 1 || pendingRaw === "1") {
    pending = true;
  } else if (typeof pendingRaw === "string") {
    const text = pendingRaw.trim();
    if (text && text !== "false" && text !== "0") {
      pending = true;
      detail = text;
    }
  } else if (pendingRaw && typeof pendingRaw === "object" && !Array.isArray(pendingRaw)) {
    const keys = Object.keys(pendingRaw as Record<string, unknown>);
    if (keys.length) {
      pending = true;
      detail = keys.join(", ");
    }
  }
  return { pending, detail, error, note };
}

/**
 * Approximate quote for a base-sized fill on an executor card.
 *
 * Quote-sized and contract-sized rows are left alone. The price is the
 * average fill, or the mid when nothing has filled.
 */
export function executorBaseSizeNote(ex: ExecutorInfo, mark?: number | null): string {
  const info = (ex.custom_info ?? {}) as Record<string, unknown>;
  const cfg = (ex.config ?? {}) as Record<string, unknown>;
  const iceberg = (ex.type || "").toLowerCase().includes("range_iceberg");
  const unit = String(cfg.size_unit ?? info.size_unit ?? "");
  if (!sizeShownInBase(unit, iceberg ? "iceberg" : "order")) return "";
  const filled = Number(info.filled_base ?? info.filled_amount);
  if (!(filled > 0)) return "";
  const price = referenceSizePrice([info, cfg, { current_price: ex.current_price }], mark);
  return approximateQuoteLabel(filled, price, pairTokens(ex.trading_pair).quote);
}

/**
 * A shallower iceberg whose entries are held while a deeper tier is the one
 * the price qualifies for. Exits keep working. This is not an order halt.
 */
export function entryPause(source: {
  custom_info?: Record<string, unknown> | null;
}): { paused: boolean; reason: string } {
  const info = source.custom_info ?? {};
  const raw = info.entry_paused;
  const paused = raw === true || raw === "true" || raw === 1 || raw === "1";
  if (!paused) return { paused: false, reason: "" };
  const reason = typeof info.pause_reason === "string" ? info.pause_reason.trim() : "";
  return { paused: true, reason };
}

/** Filled size, halt reason, and whether resume is meaningful for this row. */
export function executorRunDetail(ex: ExecutorInfo): {
  filled: string | null;
  halt: string | null;
  canResume: boolean;
  configEditPending: boolean;
  configEditError: string | null;
  configEditNote: string | null;
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
  const edit = executorConfigEdit(ex);
  return {
    filled: filledText,
    halt,
    canResume: paused && isExecutorActive(ex.status),
    configEditPending: edit.pending,
    configEditError: edit.error || null,
    configEditNote: edit.note || null,
  };
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
