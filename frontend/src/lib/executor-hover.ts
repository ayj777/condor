import type { ExecutorInfo } from "@/lib/api";
import { formatPriceSig } from "@/lib/formatters";
import { entryPause, executorConfigEdit, executorTypeLabel, icebergHasExits, icebergSizeUnitRaw, rangeIcebergTierFacts } from "@/lib/executor-run";
import {
  approximateQuoteLabel,
  formatTokenAmount,
  pairTokens,
  referenceSizePrice,
  sizeShownInBase,
  sizeUnitSymbol,
  withApproximateQuote,
} from "@/lib/order-size";

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

export interface ExecutorWarning {
  title: string;
  detail: string;
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
  warnings: ExecutorWarning[];
  /** Applied edits that carry a note. Shown apart from the warning badges. */
  notes: ExecutorWarning[];
  /** Entries are held for a deeper tier. Take profit and stop loss still run. */
  entryPaused: boolean;
  pauseReason: string;
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
export function executorHoverModel(
  executor: ExecutorInfo,
  now = Date.now(),
  markPrice?: number | null,
): ExecutorHoverModel {
  const cfg = record(executor.config);
  const info = record(executor.custom_info);
  const rows: HoverRow[] = [];
  const add = (label: string, value: string) => {
    if (value) rows.push({ label, value });
  };

  const modeRaw = text(first(info, cfg, ["mode"]));
  const mode = modeRaw ? modeLabel(modeRaw) : "";
  if (mode) add("Mode", mode);

  const rangeIceberg = (executor.type || "").toLowerCase().includes("range_iceberg");
  const sizeUnitRaw = rangeIceberg
    ? icebergSizeUnitRaw({ config: cfg, custom_info: info }) || "QUOTE"
    : text(first(cfg, info, ["size_unit"]));
  const unit = sizeUnitSymbol(sizeUnitRaw, executor.trading_pair);
  const { quote } = pairTokens(executor.trading_pair);
  const sizePrice = referenceSizePrice([info, cfg, { current_price: executor.current_price }], markPrice);
  const inBase = sizeShownInBase(sizeUnitRaw, rangeIceberg ? "iceberg" : "order");
  const total = num(pick(cfg, ["total_amount"]) ?? pick(info, ["target_amount"]) ?? pick(cfg, ["amount"]));
  const filled = num(pick(info, ["filled_amount", "filled_base"]));
  const amountText = (amount: number) => {
    const plain = unit ? `${formatTokenAmount(amount)} ${unit}` : formatTokenAmount(amount);
    return inBase ? withApproximateQuote(plain, amount, sizePrice, quote) : plain;
  };
  const filledClause = (amount: number, pct: string) => {
    const note = inBase ? approximateQuoteLabel(amount, sizePrice, quote) : "";
    const bits = [pct, note].filter(Boolean).join(", ");
    return `${formatTokenAmount(amount)} filled${bits ? ` (${bits})` : ""}`;
  };
  if (total != null && total > 0) {
    const pct = filled != null && filled >= 0 ? `${((filled / total) * 100).toFixed(1)}%` : "";
    const filledText = filled != null ? filledClause(filled, pct) : "";
    add("Size", filledText ? `${amountText(total)}, ${filledText}` : amountText(total));
  } else if (filled != null) {
    add("Filled", amountText(filled));
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
  if (slice != null && slice > 0) add("Slice", amountText(slice));

  const duration = first(cfg, info, ["duration"]);
  const durationSec = durationSeconds(duration);
  if (text(duration)) add("Duration", durationSec != null ? formatDuration(durationSec) : text(duration));
  const slices = num(first(cfg, info, ["schedule_slices"]));
  const intervalRaw = first(cfg, info, ["schedule_interval"]);
  const hasInterval = text(intervalRaw) !== "";
  let intervalSec: number | null = hasInterval ? durationSeconds(intervalRaw) : null;
  if ((intervalSec == null || !(intervalSec > 0)) && slices != null && slices >= 1 && durationSec != null && durationSec > 0) {
    intervalSec = durationSec / slices;
  }
  let perInterval = "";
  if (intervalSec != null && intervalSec > 0 && total != null && total > 0) {
    const count = !hasInterval && slices != null && slices >= 1
      ? Math.floor(slices)
      : durationSec != null && durationSec > 0 && intervalSec <= durationSec
        ? Math.max(1, Math.floor(durationSec / intervalSec))
        : null;
    if (count != null && count >= 1) perInterval = amountText(total / count);
  }
  const schedule = [
    intervalSec != null && intervalSec > 0 ? `every ${formatDuration(intervalSec)}` : "",
    perInterval,
  ].filter(Boolean).join(", ");
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

  const top = executor as unknown as Record<string, unknown>;
  const pause = entryPause(executor);
  if (pause.paused) {
    add("Paused", pause.reason || "entry paused");
    if (icebergHasExits(executor)) add("Exits", "TP and SL active");
  }
  if (rangeIceberg) {
    for (const fact of rangeIcebergTierFacts(executor)) {
      if (fact.label === "Group" || fact.label === "Sibling base") add(fact.label, fact.value);
    }
  }

  const stopInPlace = exchangeStopInPlace(info, top);
  addExitRows(rows, info, executor.trading_pair, stopInPlace, sizePrice);

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
    warnings: executorWarnings(executor, info, top, stopInPlace),
    notes: executorConfigNotes(executor),
    entryPaused: pause.paused,
    pauseReason: pause.reason,
  };
}

function owns(source: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return false;
  const value = source[key];
  if (typeof value === "boolean") return true;
  return value != null && value !== "";
}

/** custom_info wins. The executor record is the fallback when the key is only there. */
function lookup(info: Record<string, unknown>, top: Record<string, unknown>, key: string): unknown {
  if (owns(info, key)) return info[key];
  if (owns(top, key)) return top[key];
  return undefined;
}

function flag(value: unknown): boolean | null {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
}

function messageText(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    return text(row.message ?? row.error ?? row.detail);
  }
  return text(value);
}

/**
 * `has_exchange_stop` decides when the executor sends it.
 * Otherwise a stop order id still means the stop is in place, and an error means it is not.
 */
function exchangeStopInPlace(info: Record<string, unknown>, top: Record<string, unknown>): boolean {
  const raw = lookup(info, top, "has_exchange_stop");
  const parsed = flag(raw);
  if (raw !== undefined && parsed != null) return parsed;
  if (messageText(lookup(info, top, "exchange_stop_error"))) return false;
  return text(lookup(info, top, "exchange_stop_order_id")) !== "";
}

function executorWarnings(
  executor: ExecutorInfo,
  info: Record<string, unknown>,
  top: Record<string, unknown>,
  stopInPlace: boolean,
): ExecutorWarning[] {
  const warnings: ExecutorWarning[] = [];
  const stopError = messageText(lookup(info, top, "exchange_stop_error"));
  if (stopError) warnings.push({ title: "Exchange stop is not placed", detail: stopError });
  const resumeError = messageText(lookup(info, top, "resume_error"));
  if (flag(lookup(info, top, "resume_failed")) === true || resumeError) {
    warnings.push({ title: "Resume failed", detail: resumeError });
  }
  const closeType = stateToken(text(executor.close_type) || text(lookup(info, top, "close_type")));
  if (closeType === "POSITION_HOLD" && stopInPlace) {
    warnings.push({ title: "The exchange stop is still on MEXC.", detail: "" });
  }
  const edit = executorConfigEdit(executor);
  if (edit.error) warnings.push({ title: "Config edit failed", detail: edit.error });
  if (edit.pending) warnings.push({ title: "Config edit pending", detail: edit.detail });
  return warnings;
}

function executorConfigNotes(executor: ExecutorInfo): ExecutorWarning[] {
  const edit = executorConfigEdit(executor);
  if (!edit.note) return [];
  return [{ title: "Config edit", detail: edit.note }];
}

function quotePnl(value: number): string {
  const text = formatTokenAmount(Math.abs(value));
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return text;
}

const EXIT_STATE_LABELS: Record<string, string> = {
  ARMED: "Armed",
  RESTING: "TP resting",
  TRIGGERED: "Triggered",
  CLOSING: "Closing",
  DONE: "Done",
};

function stateToken(value: unknown): string {
  return text(value).replace(/^.*\./, "").replace(/[-.\s]/g, "_").toUpperCase();
}

function idCount(value: unknown): number {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).length;
  return text(value) ? 1 : 0;
}

/**
 * Exit progress from a range iceberg `custom_info`.
 *
 * `exit_state` is the source of the status label when the executor sends it:
 * a resting limit take profit stays "TP resting" instead of looking triggered.
 * Older executors still use `exit_status` and `exit_active`. Idle with no
 * trigger and no fill is left out, so an order that never armed an exit does
 * not grow a row of zeros.
 *
 * Trigger prices are the executor's own numbers. A percent on the form is only
 * an estimate from the limit or the range mid, so this card does not recompute one.
 */
function addExitRows(
  rows: HoverRow[],
  info: Record<string, unknown>,
  pair: string,
  exchangeStop: boolean,
  sizePrice: number | null,
) {
  const add = (label: string, value: string) => {
    if (value) rows.push({ label, value });
  };
  const tpTrigger = num(info.take_profit_trigger_price);
  const slTrigger = num(info.stop_loss_trigger_price);
  const legacyStatus = text(info.exit_status).toLowerCase();
  const active = text(info.exit_active).toLowerCase();
  const closed = num(pick(info, ["closed_base", "exit_filled_amount"]));
  const average = num(info.exit_average_price);
  const pnl = num(info.realized_pnl_quote);
  const openBase = num(info.open_base);
  const exchangeBase = num(info.exchange_position_base);
  const externalClose = flag(info.external_close) === true;
  const reconcile = messageText(info.reconcile_error);
  const stateKey = stateToken(info.exit_state);
  const hasExitState = stateKey !== "";
  const stateLabel =
    EXIT_STATE_LABELS[stateKey] ?? (hasExitState && stateKey !== "NONE" ? pretty(stateKey) : "");
  const exitOrders = idCount(info.exit_order_ids);

  const hasTrigger = (tpTrigger != null && tpTrigger > 0) || (slTrigger != null && slTrigger > 0);
  const hasFill = closed != null && closed > 0;
  const hasOpen = openBase != null && openBase > 0;
  const legacyMoving = legacyStatus !== "" && legacyStatus !== "idle";
  const stateMoving = stateLabel !== "";
  const flatDone = stateKey === "DONE" && openBase === 0;
  const reported =
    hasTrigger || hasFill || stateMoving || hasOpen || exchangeStop || exitOrders > 0 || flatDone
    || externalClose || exchangeBase != null || reconcile !== "";
  if (hasExitState) {
    if (!reported) return;
  } else if (!reported && !legacyMoving && !active) {
    return;
  }

  const [base, quote] = (pair || "").split("-");
  const amountText = (amount: number) => {
    const formatted = formatTokenAmount(amount);
    const plain = base ? `${formatted} ${base}` : formatted;
    return withApproximateQuote(plain, amount, sizePrice, quote || "");
  };
  // Prices the executor is using. A percent stays absent until a fill exists,
  // because the executor measures it from the average fill. This card does not
  // estimate one from the limit or the range mid.
  if (tpTrigger != null && tpTrigger > 0) add("TP trigger", priceText(tpTrigger));
  if (slTrigger != null && slTrigger > 0) add("SL trigger", priceText(slTrigger));
  if (hasExitState) {
    if (stateLabel) add("Exit status", stateLabel);
    const started = stateKey === "TRIGGERED" || stateKey === "CLOSING" || stateKey === "DONE";
    if (started && active) add("Exit", pretty(active));
  } else {
    if (legacyStatus && (legacyStatus !== "idle" || hasTrigger || hasFill || active)) {
      add("Exit status", pretty(legacyStatus));
    }
    if (active) add("Exit", pretty(active));
  }
  if (externalClose) add("Position (shared)", "flat");
  else if (exchangeBase != null) add("Position (shared)", amountText(exchangeBase));
  if (hasOpen || (openBase === 0 && stateKey === "DONE")) add("Tier open", amountText(openBase ?? 0));
  if (reconcile) add("Reconcile error", reconcile);
  if (hasFill && closed != null) add("Exit filled", amountText(closed));
  if (exchangeStop) add("Exchange stop", "In place");
  if (exitOrders > 0) add("Exit orders", String(exitOrders));
  if (average != null && average > 0) add("Exit avg", priceText(average));
  const showPnl = hasExitState ? hasFill || stateMoving || hasOpen || exchangeStop : hasFill || legacyMoving || active;
  if (pnl != null && showPnl) {
    add("Realized PnL", quote ? `${quotePnl(pnl)} ${quote}` : quotePnl(pnl));
  }
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
