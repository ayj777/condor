import type { ExecutorInfo } from "@/lib/api";
import { formatPriceSig } from "@/lib/formatters";
import { executorTypeLabel } from "@/lib/executor-run";

export interface HoverOrder {
  price: string;
  amount: string;
  filled: string;
  status: string;
}

export interface HoverRow {
  label: string;
  value: string;
}

export interface ExecutorHoverModel {
  type: string;
  side: string;
  positionSide: string;
  status: string;
  rows: HoverRow[];
  orders: HoverOrder[];
  closeType: string;
  statusMessage: string;
}

const WORKING = new Set([
  "",
  "OPEN",
  "NEW",
  "WORKING",
  "SUBMITTED",
  "PENDING_CREATE",
  "PARTIALLY_FILLED",
  "PENDING_CANCEL",
]);
const DONE = new Set(["FILLED", "CANCELED", "CANCELLED", "FAILED", "COMPLETED", "EXPIRED"]);
const ORDER_KEYS = ["open_orders", "active_orders", "working_orders", "close_orders", "orders", "levels"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw || raw === "null" || raw === "undefined" || raw === "None") return "";
  return raw;
}

function pick(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function first(info: Record<string, unknown>, cfg: Record<string, unknown>, keys: string[]): unknown {
  return pick(info, keys) ?? pick(cfg, keys);
}

function modeLabel(raw: string): string {
  const collapsed = raw.replace(/[-_\s.]/g, "").toUpperCase();
  if (collapsed.endsWith("UPTO")) return "Up to";
  if (collapsed.endsWith("RANGE")) return "Range";
  return raw;
}

const NAMED: Record<string, string> = {
  REST_AT_CAP: "Rest at cap",
  WAIT: "Wait",
  CARRY: "Carry",
  SKIP: "Skip",
};

function pretty(raw: string): string {
  const named = NAMED[raw.replace(/[-.\s]/g, "_").toUpperCase()];
  if (named) return named;
  return raw
    .replace(/[._]/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function yesNo(value: unknown): string {
  if (value === true || value === "true" || value === 1 || value === "1") return "Yes";
  if (value === false || value === "false" || value === 0 || value === "0") return "No";
  return text(value);
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  return `${secs}s`;
}

function durationSeconds(value: unknown): number | null {
  const direct = num(value);
  if (direct != null) return direct;
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])?$/i.exec(raw);
  if (!match) return null;
  const magnitude = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const scale = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return magnitude * scale;
}

function startedAt(executor: ExecutorInfo): number | null {
  const stamp = num(executor.timestamp);
  if (stamp == null || stamp <= 0) return null;
  return stamp > 1e12 ? stamp : stamp * 1000;
}

/** Malaysia time. The trade desk reads the clock in MYT. */
export function formatStartMyt(epochMs: number): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
  return `${formatted} MYT`;
}

function priceText(value: number): string {
  if (!(value > 0)) return "";
  const raw = formatPriceSig(value);
  if (!raw.includes(".")) return raw;
  return raw.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function orderStatus(row: Record<string, unknown>): string {
  return text(pick(row, ["status", "state"])).replace(/^.*\./, "").toUpperCase();
}

function isWorking(row: Record<string, unknown>, key: string): boolean {
  const status = orderStatus(row);
  if (DONE.has(status)) return false;
  const listedOpen = key === "open_orders" || key === "active_orders" || key === "working_orders";
  if (listedOpen) return status === "" || WORKING.has(status);
  return status !== "" && WORKING.has(status);
}

function hoverOrders(info: Record<string, unknown>): HoverOrder[] {
  const seen = new Set<string>();
  const orders: HoverOrder[] = [];
  for (const key of ORDER_KEYS) {
    const list = info[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const row = record(item);
      if (!isWorking(row, key)) continue;
      const exchangeId = text(pick(row, ["exchange_order_id", "exchangeOrderId", "order_id", "client_order_id"]));
      const dedupe = exchangeId || JSON.stringify(row);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const price = num(pick(row, ["price", "limit_price"]));
      const amount = num(pick(row, ["amount", "size", "quantity"]));
      const filled = num(pick(row, ["filled_amount", "filled", "executed_amount"]));
      orders.push({
        price: price != null ? priceText(price) : "",
        amount: amount != null ? String(amount) : "",
        filled: filled != null ? String(filled) : "",
        status: orderStatus(row) || "OPEN",
      });
    }
  }
  return orders;
}

/** The order card for one executor row. Empty fields are left out. */
export function executorHoverModel(executor: ExecutorInfo, now = Date.now()): ExecutorHoverModel {
  const cfg = record(executor.config);
  const info = record(executor.custom_info);
  const rows: HoverRow[] = [];
  const add = (label: string, value: string) => {
    if (value) rows.push({ label, value });
  };

  const modeRaw = text(first(info, cfg, ["mode"]));
  const mode = modeRaw ? modeLabel(modeRaw) : "";
  if (mode) add("Mode", mode);

  const unit = text(first(cfg, info, ["size_unit"])) || "BASE";
  const total = num(pick(cfg, ["total_amount"]) ?? pick(info, ["target_amount"]) ?? pick(cfg, ["amount"]));
  const filled = num(pick(info, ["filled_amount"]));
  if (total != null && total > 0) {
    const pct = filled != null && filled >= 0 ? ` (${((filled / total) * 100).toFixed(1)}%)` : "";
    const filledText = filled != null ? `${filled} filled${pct}` : "";
    add("Size", filledText ? `${total} ${unit}, ${filledText}` : `${total} ${unit}`);
  } else if (filled != null) {
    add("Filled", `${filled} ${unit}`);
  }

  const limit = num(first(cfg, info, ["limit_price"]));
  const low = num(first(cfg, info, ["price_low", "start_price"]));
  const high = num(first(cfg, info, ["price_high", "end_price"]));
  if (mode === "Up to" && limit != null && limit > 0) add("Limit", priceText(limit));
  else if (mode === "Range" && low != null && high != null && low > 0 && high > 0) {
    add("Range", `${priceText(low)} to ${priceText(high)}`);
  } else if (limit != null && limit > 0) add("Limit", priceText(limit));
  else if (low != null && high != null && low > 0 && high > 0) {
    add("Range", `${priceText(low)} to ${priceText(high)}`);
  }

  const iceberg = first(cfg, info, ["iceberg"]);
  if (iceberg != null && iceberg !== "") add("Iceberg", yesNo(iceberg));
  const visible = num(first(cfg, info, ["visible_count"]));
  if (visible != null) add("Visible", String(visible));
  const levelCount = num(cfg.levels) ?? (Array.isArray(info.levels) ? null : num(info.levels));
  if (levelCount != null) add("Levels", String(levelCount));
  const slice = num(first(cfg, info, ["slice_amount"]));
  if (slice != null && slice > 0) add("Slice", `${slice} ${unit}`);

  const duration = first(cfg, info, ["duration"]);
  const durationSec = durationSeconds(duration);
  if (text(duration)) add("Duration", durationSec != null ? formatDuration(durationSec) : text(duration));
  const slices = num(first(cfg, info, ["schedule_slices"]));
  const intervalRaw = first(cfg, info, ["schedule_interval"]);
  const intervalNum = num(intervalRaw);
  const interval = intervalNum != null ? formatDuration(intervalNum) : text(intervalRaw);
  const schedule = [slices != null && slices > 0 ? `${slices} slices` : "", interval ? `every ${interval}` : ""]
    .filter(Boolean)
    .join(", ");
  if (schedule) add("Schedule", schedule);
  const started = startedAt(executor);
  if (durationSec != null && started != null) {
    const remaining = durationSec - (now - started) / 1000;
    add("Remaining", remaining > 0 ? formatDuration(remaining) : "0s");
  }

  const cap = text(first(cfg, info, ["cap_behavior"]));
  if (cap) add("Cap", pretty(cap));
  const catchUp = text(first(cfg, info, ["catch_up"]));
  if (catchUp) add("Catch up", pretty(catchUp));
  const reduceOnly = first(cfg, info, ["reduce_only"]);
  if (reduceOnly != null && reduceOnly !== "") add("Reduce only", yesNo(reduceOnly));

  const stop = num(pick(cfg, ["stop_loss"]));
  const take = num(pick(cfg, ["take_profit"]));
  if (stop != null && stop > 0 && stop !== -1) add("Stop loss", `${(stop * 100).toFixed(2)}%`);
  if (take != null && take > 0 && take !== -1) add("Take profit", `${(take * 100).toFixed(2)}%`);

  const avg = num(first(info, cfg, [
    "average_fill_price",
    "avg_fill_price",
    "average_filled_price",
    "current_position_average_price",
  ]));
  if (avg != null && avg > 0) add("Avg fill", priceText(avg));

  if (started != null) add("Started", formatStartMyt(started));

  const positionSide = text(first(cfg, info, ["position_side", "positionSide"])).replace(/^.*\./, "").toUpperCase();
  const statusMessage = text(first(info, cfg, ["status_reason", "status_message", "error_message", "close_message"]));

  return {
    type: executorTypeLabel(executor),
    side: text(executor.side).toUpperCase(),
    positionSide,
    status: text(executor.status),
    rows,
    orders: hoverOrders(info),
    closeType: pretty(text(executor.close_type)),
    statusMessage,
  };
}

export interface PopupAnchor {
  top: number;
  left: number;
  bottom: number;
  width: number;
}

/** Keep the card on screen. Prefer above the row, then below, then pin to the edge. */
export function placePopup(
  anchor: PopupAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { top: number; left: number; maxHeight: number } {
  const maxHeight = Math.max(120, viewport.height - margin * 2);
  const height = Math.min(size.height, maxHeight);
  let left = anchor.left;
  if (left + size.width > viewport.width - margin) left = viewport.width - size.width - margin;
  if (left < margin) left = margin;
  // Overlap the row by a few pixels so the pointer can move onto the card.
  const overlap = 4;
  const above = anchor.top + overlap - height;
  const below = anchor.bottom - overlap;
  let top = above >= margin ? above : below;
  if (top + height > viewport.height - margin) top = Math.max(margin, viewport.height - margin - height);
  return { top, left, maxHeight };
}
