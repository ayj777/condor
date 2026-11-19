import type { OrderState } from "@/components/executor/order-config";
import { ORDER_DEFAULTS, rangeIcebergInput } from "@/components/executor/order-config";
import { rangeIcebergMode } from "@/lib/executor-run";
import { formatTokenAmount, pairTokens } from "@/lib/order-size";
import {
  rangeIcebergExitConfig,
  validateRangeIcebergExits,
  type ExitKind,
  type RangeIcebergExitInput,
  type RangeMode,
} from "@/lib/range-iceberg";

/**
 * An in-place edit of a live range iceberg.
 *
 * The patch is the subset that changed. An exit the user turned off is null,
 * which clears it. Price bounds are omitted for an up-to iceberg.
 */

export interface RangeIcebergEditSource {
  type?: string;
  side?: string;
  status?: string;
  close_type?: string;
  trading_pair?: string;
  config?: Record<string, unknown> | null;
  custom_info?: Record<string, unknown> | null;
}

export interface RangeIcebergEditDraft {
  mode: RangeMode;
  side: "BUY" | "SELL";
  totalAmount: number;
  priceLow: number;
  priceHigh: number;
  /** Exit reference for an up-to iceberg. Not sent. */
  limitPrice: number;
  takeProfit: RangeIcebergExitInput | null;
  stopLoss: RangeIcebergExitInput | null;
}

const TERMINATING = new Set(["SHUTTING_DOWN", "TERMINATING", "STOPPING", "CLOSING"]);

function token(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^CloseType\./i, "")
    .replace(/[\s.-]+/g, "_")
    .toUpperCase();
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function read(source: RangeIcebergEditSource, key: string): unknown {
  const config = source.config ?? {};
  if (Object.prototype.hasOwnProperty.call(config, key)) return config[key];
  const info = source.custom_info ?? {};
  if (Object.prototype.hasOwnProperty.call(info, key)) return info[key];
  return undefined;
}

function editSide(source: RangeIcebergEditSource): "BUY" | "SELL" {
  const raw = source.side || source.config?.side || source.custom_info?.side;
  const text = String(raw ?? "").trim().toUpperCase();
  if (text === "SELL" || text === "SHORT" || text === "2") return "SELL";
  return "BUY";
}

function whole(value: unknown, fallback: number): number {
  const parsed = Math.trunc(num(value));
  return parsed >= 1 ? parsed : fallback;
}

function readExit(raw: unknown): RangeIcebergExitInput | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const execution = String(row.execution || "SINGLE").toUpperCase() === "ICEBERG" ? "ICEBERG" : "SINGLE";
  const percent = num(row.percent);
  const hasPercent = row.percent != null && row.percent !== "" && percent > 0;
  const hasRange = (row.price_low != null && row.price_low !== "")
    || (row.price_high != null && row.price_high !== "");
  const orderType = String(row.order_type || "LIMIT").toUpperCase() === "MARKET" ? "MARKET" : "LIMIT";
  return {
    trigger: hasPercent ? "percent" : "price",
    percent: hasPercent ? percent : 0,
    price: hasPercent ? 0 : num(row.price),
    execution,
    orderType,
    slices: whole(row.slices, 1),
    visibleCount: whole(row.visible_count ?? row.visibleCount, 1),
    interval: row.interval == null || row.interval === "" ? "" : String(row.interval),
    priceStyle: execution === "ICEBERG" && hasRange ? "RANGE" : "LIMIT",
    limitPrice: num(row.limit_price),
    priceLow: num(row.price_low),
    priceHigh: num(row.price_high),
  };
}

export type RangeIcebergSizeUnit = "BASE" | "QUOTE" | "CONTRACTS";

function bags(source: RangeIcebergEditSource): Record<string, unknown>[] {
  return [source.custom_info ?? {}, source.config ?? {}, source as Record<string, unknown>];
}

function ownNumber(records: Record<string, unknown>[], keys: string[]): number | null {
  for (const record of records) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const value = record[key];
      if (value == null || value === "") continue;
      const parsed = num(value);
      if (parsed >= 0) return parsed;
    }
  }
  return null;
}

function sizeUnitToken(value: unknown): RangeIcebergSizeUnit | null {
  const raw = token(value).split("_").pop() ?? "";
  if (raw === "BASE") return "BASE";
  if (raw === "QUOTE") return "QUOTE";
  if (raw === "CONTRACT" || raw === "CONTRACTS") return "CONTRACTS";
  return null;
}

/**
 * The unit `total_amount` is denominated in.
 *
 * A live `custom_info.size_unit` wins, because a resumed iceberg can be sized
 * in base while the saved config still says quote. An absent unit is quote,
 * which is the executor default.
 */
export function rangeIcebergSizeUnit(source: RangeIcebergEditSource): RangeIcebergSizeUnit {
  const info = source.custom_info ?? {};
  return sizeUnitToken(info.size_unit) ?? sizeUnitToken(source.config?.size_unit) ?? "QUOTE";
}

/**
 * Filled size in the same unit as `total_amount`.
 *
 * `filled_quote` and `filled_amount` are already in that unit when the
 * executor sends them. Otherwise a quote fill is base times the average fill,
 * and a contract fill is base divided by the contract size. Null means the
 * client cannot tell, so the shrink check is left to the trading API.
 */
export function rangeIcebergFilledInUnit(source: RangeIcebergEditSource): number | null {
  const records = bags(source);
  const unit = rangeIcebergSizeUnit(source);
  const filledBase = ownNumber(records, ["filled_base"]);
  const filledQuote = ownNumber(records, ["filled_quote", "filled_amount_quote"]);
  const filledAmount = ownNumber(records, ["filled_amount"]);
  const average = ownNumber(records, [
    "average_fill_price",
    "avg_fill_price",
    "average_filled_price",
    "average_entry_price",
    "current_position_average_price",
  ]);
  const contractSize = ownNumber(records, ["contract_size", "contractSize"]);

  if (unit === "BASE") {
    if (filledBase != null) return filledBase;
    if (filledAmount != null) return filledAmount;
    if (filledQuote != null && average != null && average > 0) return filledQuote / average;
    return null;
  }
  if (unit === "CONTRACTS") {
    if (filledAmount != null) return filledAmount;
    if (filledBase === 0) return 0;
    if (filledBase != null && contractSize != null && contractSize > 0) return filledBase / contractSize;
    return null;
  }
  if (filledQuote != null) return filledQuote;
  if (filledAmount != null) return filledAmount;
  if (filledBase === 0) return 0;
  if (filledBase != null && average != null && average > 0) return filledBase * average;
  return null;
}

/** Ticker next to the total, matching `rangeIcebergSizeUnit`. */
export function rangeIcebergTotalUnitLabel(source: RangeIcebergEditSource, pair?: string): string {
  const { base, quote } = pairTokens(pair);
  const unit = rangeIcebergSizeUnit(source);
  if (unit === "QUOTE") return quote || "quote";
  if (unit === "CONTRACTS") return "contracts";
  return base || "base";
}

/**
 * Filled text for the form. The in-unit amount is used when it is known.
 * A base fill with no conversion is still shown, labeled in the base ticker,
 * and is not used as the shrink limit.
 */
export function rangeIcebergFilledCaption(source: RangeIcebergEditSource, pair?: string): string {
  const { base } = pairTokens(pair);
  const inUnit = rangeIcebergFilledInUnit(source);
  if (inUnit != null) {
    const label = rangeIcebergTotalUnitLabel(source, pair);
    return [formatTokenAmount(inUnit), label].filter(Boolean).join(" ");
  }
  const filledBase = ownNumber([source.custom_info ?? {}], ["filled_base"]);
  if (filledBase == null) return "";
  return [formatTokenAmount(filledBase), base].filter(Boolean).join(" ");
}

/** Running range icebergs can be edited. A parked or closing row cannot. */
export function rangeIcebergEditable(source: RangeIcebergEditSource): boolean {
  if (!(source.type || "").toLowerCase().includes("range_iceberg")) return false;
  const status = token(source.status);
  if (status !== "RUNNING" && status !== "ACTIVE") return false;
  if (TERMINATING.has(status)) return false;
  const close = token(source.close_type || source.custom_info?.close_type);
  if (close === "POSITION_HOLD" || close === "POSITION_CLOSED_EXTERNALLY") return false;
  const external = source.custom_info?.external_close;
  if (external === true || external === "true" || external === 1 || external === "1") return false;
  const exitState = token(
    source.custom_info?.exit_state
      ?? (source as { exit_state?: unknown }).exit_state,
  );
  if (exitState === "CLOSING" || exitState === "DONE") return false;
  return true;
}

export function rangeIcebergEditFromExecutor(source: RangeIcebergEditSource): RangeIcebergEditDraft {
  const total = read(source, "total_amount");
  const info = source.custom_info ?? {};
  const totalAmount = total != null && total !== ""
    ? num(total)
    : num(info.target_amount);
  const mode = rangeIcebergMode(source) === "UP_TO" ? "UP_TO" : "RANGE";
  return {
    mode,
    side: editSide(source),
    totalAmount,
    priceLow: num(read(source, "price_low")),
    priceHigh: num(read(source, "price_high")),
    limitPrice: num(read(source, "limit_price")),
    takeProfit: readExit(read(source, "take_profit")),
    stopLoss: readExit(read(source, "stop_loss")),
  };
}

function withExit(
  state: OrderState,
  which: "tp" | "sl",
  exit: RangeIcebergExitInput | null,
): OrderState {
  if (which === "tp") {
    return {
      ...state,
      ri_tp_enabled: exit != null,
      ri_tp_trigger: exit?.trigger ?? state.ri_tp_trigger,
      ri_tp_percent: exit?.percent ?? state.ri_tp_percent,
      ri_tp_price: exit?.price ?? state.ri_tp_price,
      ri_tp_execution: exit?.execution ?? state.ri_tp_execution,
      ri_tp_order_type: exit?.orderType ?? state.ri_tp_order_type,
      ri_tp_slices: exit?.slices ?? state.ri_tp_slices,
      ri_tp_visible_count: exit?.visibleCount ?? state.ri_tp_visible_count,
      ri_tp_interval: exit?.interval ?? state.ri_tp_interval,
      ri_tp_price_style: exit?.priceStyle ?? state.ri_tp_price_style,
      ri_tp_limit_price: exit?.limitPrice ?? state.ri_tp_limit_price,
      ri_tp_price_low: exit?.priceLow ?? state.ri_tp_price_low,
      ri_tp_price_high: exit?.priceHigh ?? state.ri_tp_price_high,
    };
  }
  return {
    ...state,
    ri_sl_enabled: exit != null,
    ri_sl_trigger: exit?.trigger ?? state.ri_sl_trigger,
    ri_sl_percent: exit?.percent ?? state.ri_sl_percent,
    ri_sl_price: exit?.price ?? state.ri_sl_price,
    ri_sl_execution: exit?.execution ?? state.ri_sl_execution,
    ri_sl_slices: exit?.slices ?? state.ri_sl_slices,
    ri_sl_visible_count: exit?.visibleCount ?? state.ri_sl_visible_count,
    ri_sl_interval: exit?.interval ?? state.ri_sl_interval,
    ri_sl_price_style: exit?.priceStyle ?? state.ri_sl_price_style,
    ri_sl_limit_price: exit?.limitPrice ?? state.ri_sl_limit_price,
    ri_sl_price_low: exit?.priceLow ?? state.ri_sl_price_low,
    ri_sl_price_high: exit?.priceHigh ?? state.ri_sl_price_high,
  };
}

/** Order form state for the shared take profit and stop loss editors. */
export function orderStateForEdit(draft: RangeIcebergEditDraft): OrderState {
  const base: OrderState = {
    ...ORDER_DEFAULTS,
    execution_strategy: "RANGE_ICEBERG",
    side: draft.side === "SELL" ? 2 : 1,
    ri_mode: draft.mode,
    ri_total_amount: draft.totalAmount,
    ri_price_low: draft.priceLow,
    ri_price_high: draft.priceHigh,
    ri_limit_price: draft.limitPrice,
  };
  return withExit(withExit(base, "tp", draft.takeProfit), "sl", draft.stopLoss);
}

export function draftFromOrderState(state: OrderState): RangeIcebergEditDraft {
  const input = rangeIcebergInput(state);
  return {
    mode: input.mode,
    side: input.side,
    totalAmount: input.totalAmount,
    priceLow: input.priceLow,
    priceHigh: input.priceHigh,
    limitPrice: input.limitPrice,
    takeProfit: input.takeProfit ?? null,
    stopLoss: input.stopLoss ?? null,
  };
}

/** The draft the form actually edits, after the shared exit fields normalize it. */
export function normalizedEditDraft(draft: RangeIcebergEditDraft): RangeIcebergEditDraft {
  return draftFromOrderState(orderStateForEdit(draft));
}

/** Live `slice_amount` in the same unit as the total. Zero when the executor has none. */
export function liveSliceAmount(source: RangeIcebergEditSource): number {
  const value = read(source, "slice_amount");
  return value == null || value === "" ? 0 : num(value);
}

function textOf(source: RangeIcebergEditSource, key: string): string {
  const value = read(source, key);
  return value == null ? "" : String(value).trim();
}

/**
 * Settings the edit endpoint cannot change. Shown so a total edit does not
 * look like it will move the schedule, the ladder, or the leverage.
 */
export function frozenIcebergLines(source: RangeIcebergEditSource, pair?: string): string[] {
  const lines: string[] = [];
  const duration = textOf(source, "duration");
  const interval = textOf(source, "schedule_interval");
  const start = textOf(source, "schedule_start").toUpperCase();
  if (duration) {
    const clock = start === "SUBMIT" ? "clock starts at submit" : "clock starts at the first fill";
    const every = interval ? ` every ${interval}` : "";
    lines.push(`Schedule ${duration}${every}, ${clock}`);
  }
  const levels = num(read(source, "levels"));
  if (levels > 0) lines.push(`${levels} price rungs`);
  const iceberg = read(source, "iceberg");
  const visible = num(read(source, "visible_count"));
  if (iceberg === true || String(iceberg).toLowerCase() === "true") {
    lines.push(`Iceberg on${visible > 0 ? `, ${visible} visible` : ""}`);
  } else if (iceberg === false || String(iceberg).toLowerCase() === "false") {
    lines.push("Iceberg off");
  }
  const slice = liveSliceAmount(source);
  if (slice > 0) {
    lines.push(`Slice amount ${formatTokenAmount(slice)} ${rangeIcebergTotalUnitLabel(source, pair)}`);
  }
  const leverage = num(read(source, "leverage"));
  if (leverage >= 1) lines.push(`Leverage ${leverage}x`);
  const margin = textOf(source, "margin_mode");
  if (margin) lines.push(`Margin ${margin}`);
  return lines;
}

export function validateRangeIcebergEdit(
  draft: RangeIcebergEditDraft,
  filled: number | null,
  sliceAmount = 0,
): string | null {
  if (!(draft.totalAmount > 0)) return "Total amount is required";
  if (filled != null && filled > 0 && draft.totalAmount + 1e-9 < filled) {
    return "Total amount cannot be below the filled amount";
  }
  if (sliceAmount > 0 && draft.totalAmount + 1e-9 < sliceAmount) {
    return "Total amount cannot be below the live slice amount";
  }
  if (draft.mode === "RANGE") {
    if (!(draft.priceLow > 0) || !(draft.priceHigh > 0)) {
      return "Price low and price high are required";
    }
    if (draft.priceLow > draft.priceHigh) return "Price low must be at or below price high";
  }
  return validateRangeIcebergExits(rangeIcebergInput(orderStateForEdit(draft)));
}

function sameAmount(left: number, right: number): boolean {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) <= scale * 1e-9;
}

/** Fields the edit endpoint accepts on an exit. Anything else is a 422. */
const EDIT_EXIT_FIELDS = [
  "percent",
  "price",
  "execution",
  "order_type",
  "slices",
  "visible_count",
  "interval",
  "limit_price",
  "price_low",
  "price_high",
] as const;

function editExitPayload(
  kind: ExitKind,
  exit: RangeIcebergExitInput,
): Record<string, unknown> {
  const raw = rangeIcebergExitConfig(kind, exit);
  const body: Record<string, unknown> = {};
  for (const key of EDIT_EXIT_FIELDS) {
    if (key in raw) body[key] = raw[key];
  }
  return body;
}

function numericToken(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `5`, `"5"`, and `"5.0"` are one interval. `30s` stays text. */
function sameToken(left: unknown, right: unknown): boolean {
  const a = numericToken(left);
  const b = numericToken(right);
  if (a != null && b != null) return sameAmount(a, b);
  return String(left ?? "") === String(right ?? "");
}

function sameExit(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameToken(left[key], right[key])) return false;
  }
  return true;
}

function changedExit(
  kind: ExitKind,
  before: RangeIcebergExitInput | null,
  after: RangeIcebergExitInput | null,
): Record<string, unknown> | null | undefined {
  const left = before ? editExitPayload(kind, before) : null;
  const right = after ? editExitPayload(kind, after) : null;
  if (sameExit(left, right)) return undefined;
  return right;
}

/**
 * Fields that differ. Null clears an exit. Undefined means the caller omits
 * the key. An up-to iceberg does not send price bounds.
 */
export function rangeIcebergEditPatch(
  before: RangeIcebergEditDraft,
  after: RangeIcebergEditDraft,
): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (!sameAmount(before.totalAmount, after.totalAmount)) body.total_amount = after.totalAmount;
  if (after.mode === "RANGE") {
    if (!sameAmount(before.priceLow, after.priceLow)) body.price_low = after.priceLow;
    if (!sameAmount(before.priceHigh, after.priceHigh)) body.price_high = after.priceHigh;
  }
  const take = changedExit("take_profit", before.takeProfit, after.takeProfit);
  if (take !== undefined) body.take_profit = take;
  const stop = changedExit("stop_loss", before.stopLoss, after.stopLoss);
  if (stop !== undefined) body.stop_loss = stop;
  return Object.keys(body).length ? body : null;
}
