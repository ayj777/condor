import { buildRangeLadder, type RangeLadder } from "./range-ladder";
import { floorBaseAmount, formatTokenAmount, orderStep, type SizeRule } from "./order-size";

/**
 * Client-side twin of `RangeIcebergExecutorConfig`.
 *
 * The validator on the Hummingbot side is the one that rejects a create. This
 * module repeats its rules so the form can say why before the POST. A quote
 * range is sent as quote. The preview converts each rung at that rung's price,
 * the same split as `ladder.py`. An up-to quote order is also sent as quote.
 * Its base figure is the limit price, and a better fill buys more base.
 */

export type RangeMode = "RANGE" | "UP_TO";
export type SizeUnit = "BASE" | "QUOTE" | "CONTRACTS";
export type CapBehavior = "REST_AT_CAP" | "WAIT";
export type Distribution = "LINEAR" | "GEOMETRIC" | "WEIGHTED";
export type CatchUp = "CARRY" | "SKIP";
export type ScheduleStart = "SUBMIT" | "FIRST_FILL";
export type MarginMode = "ISOLATED" | "CROSS";
export type ExitArming = "ON_FULL_FILL" | "ON_ANY_FILL";
export type ExitTrigger = "percent" | "price";
export type ExitExecution = "SINGLE" | "ICEBERG";
export type ExitOrderType = "LIMIT" | "MARKET";
export type ExitPriceStyle = "LIMIT" | "RANGE";
export type ExitKind = "take_profit" | "stop_loss";

/**
 * One optional close. `percent` is a fraction (0.02 is 2%) and is exclusive
 * with `price`. An iceberg close needs a limit cap or a price range.
 */
export interface RangeIcebergExitInput {
  trigger: ExitTrigger;
  /** Fraction of the entry price. 0.02 is 2%. */
  percent: number;
  price: number;
  execution: ExitExecution;
  /** Single take profit only. A single stop loss is always a market order. */
  orderType: ExitOrderType;
  slices: number;
  visibleCount: number;
  /** Seconds or `30s`. Empty releases every slice when the exit starts. */
  interval: string;
  priceStyle: ExitPriceStyle;
  limitPrice: number;
  priceLow: number;
  priceHigh: number;
}

export interface RangeIcebergInput {
  side: "BUY" | "SELL";
  mode: RangeMode;
  totalAmount: number;
  sizeUnit: SizeUnit;
  priceLow: number;
  priceHigh: number;
  limitPrice: number;
  iceberg: boolean;
  visibleCount: number;
  levels: number;
  duration: string;
  /** Empty releases the whole size at once. Seconds or `10m`. */
  scheduleInterval: string;
  /** Used only when a duration is set. Submit starts the clock immediately. */
  scheduleStart: ScheduleStart;
  catchUp: CatchUp;
  capBehavior: CapBehavior;
  leverage: number;
  marginMode: MarginMode;
  reduceOnly: boolean;
  distribution: Distribution;
  weight: number;
  postOnly: boolean;
  sliceAmount: number;
  sizeJitterPct: number;
  priceJitterPct: number;
  timingJitterPct: number;
  minOrderInterval: number;
  /** Empty means no expiry. Seconds or `30m`. Measured from submit. */
  expiry: string;
  expirySeconds: number;
  maxSlippage: number;
  randomSeed: string;
  /** Omitted from the payload when both exits are off. Default is a full fill. */
  exitArming?: ExitArming;
  /** Null leaves the exit out of the create payload. */
  takeProfit?: RangeIcebergExitInput | null;
  stopLoss?: RangeIcebergExitInput | null;
}

const DURATION = /^\s*(\d+(?:\.\d+)?)\s*([smhd])?\s*$/i;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Seconds from a number or `24h` / `30m` / `45s` / `1d`. Null when it does not parse. */
export function parseDuration(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const text = value.trim();
  if (!text) return null;
  const match = DURATION.exec(text);
  if (!match) return null;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude)) return null;
  const unit = (match[2] || "s").toLowerCase();
  return magnitude * UNIT_SECONDS[unit];
}

export interface RangeIcebergPreview {
  total: number;
  perSlice: number;
  /** Seconds between scheduled slices. Null when the order goes out at once. */
  intervalSeconds: number | null;
  maxPrice: number | null;
  /** Price rungs for a range, or the child count for an up-to order. */
  sliceCount: number;
  /** Scheduled releases. Null when the size goes out at once. */
  releaseCount: number | null;
}

/**
 * How many releases a duration and interval make.
 *
 * The executor uses `max(1, floor(duration / interval))`. A longer interval
 * than the duration is not a schedule this helper accepts.
 */
export function scheduleSliceCount(durationSeconds: number, intervalSeconds: number): number | null {
  if (!(durationSeconds > 0) || !(intervalSeconds > 0) || intervalSeconds > durationSeconds) return null;
  return Math.max(1, Math.floor(durationSeconds / intervalSeconds));
}

/** True when the last part of the duration is shorter than one interval. */
export function scheduleHasRemainder(durationSeconds: number, intervalSeconds: number): boolean {
  const count = scheduleSliceCount(durationSeconds, intervalSeconds);
  if (count == null) return false;
  return durationSeconds - count * intervalSeconds > 1e-6;
}

/**
 * An interval string for a saved slice count.
 *
 * `duration / slices`, written so parsing it back still floors to that count.
 */
export function intervalFromSliceCount(durationSeconds: number, slices: number): string | null {
  if (!(durationSeconds > 0) || !(slices >= 1)) return null;
  const exact = durationSeconds / slices;
  const units: Array<[string, number]> = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
  for (const [unit, scale] of units) {
    const magnitude = exact / scale;
    const whole = Math.round(magnitude);
    if (whole > 0 && Math.abs(magnitude - whole) < 1e-9) {
      const text = unit === "s" ? String(whole) : `${whole}${unit}`;
      const parsed = parseDuration(text);
      if (parsed != null && scheduleSliceCount(durationSeconds, parsed) === slices) return text;
    }
  }
  for (let digits = 6; digits <= 12; digits += 1) {
    const text = `${exact.toFixed(digits)}s`;
    const parsed = parseDuration(text);
    if (parsed != null && scheduleSliceCount(durationSeconds, parsed) === slices) return text;
  }
  const upper = durationSeconds / slices;
  const lower = durationSeconds / (slices + 1);
  const mid = (upper + lower) / 2;
  return `${mid.toPrecision(12)}s`;
}

function scheduleCount(input: RangeIcebergInput, seconds: number | null): number | null {
  if (seconds == null) return null;
  const interval = parseDuration(input.scheduleInterval);
  if (interval == null) return null;
  return scheduleSliceCount(seconds, interval);
}

/** How many orders can rest at once. Iceberg uses the visible count. Otherwise the schedule, else the rungs. */
export function restingOrderCount(
  input: Pick<RangeIcebergInput, "iceberg" | "visibleCount" | "levels" | "duration" | "scheduleInterval">,
): number {
  if (input.iceberg) return Math.max(1, Math.trunc(input.visibleCount) || 1);
  const seconds = input.duration.trim() ? parseDuration(input.duration) : null;
  const interval = input.scheduleInterval.trim() ? parseDuration(input.scheduleInterval) : null;
  if (seconds != null && interval != null) {
    const count = scheduleSliceCount(seconds, interval);
    if (count != null) return count;
  }
  return Math.max(1, Math.trunc(input.levels) || 1);
}

export function restingOrderText(count: number): string {
  return count === 1 ? "1 order can rest at once." : `${count} orders can rest at once.`;
}

/**
 * What the Iceberg strategy places.
 *
 * `visible_count` 1 is one working order. A later schedule window only adds
 * size to the queue until that order fills. A larger count is how many may
 * rest together.
 */
export function oneAtATimeText(visibleCount: number, duration: string, interval: string): string {
  const count = Math.max(1, Math.trunc(visibleCount) || 1);
  const body = count === 1
    ? "One order at a time. The next is placed after the previous one fills."
    : `${count} orders at a time. The next is placed after one of them fills.`;
  const seconds = duration.trim() ? parseDuration(duration) : null;
  const every = interval.trim() ? parseDuration(interval) : null;
  if (seconds == null || every == null || scheduleSliceCount(seconds, every) == null) return body;
  return `${body} A new share is released every ${formatInterval(every)}.`;
}

export function scheduleStartLine(start: ScheduleStart): string {
  return start === "FIRST_FILL"
    ? "The clock starts at the first fill. Until then only the first release is placed."
    : "The clock starts when you submit.";
}

/** The preview the form shows. Null until a total has been entered. */
export function rangeIcebergPreview(input: RangeIcebergInput): RangeIcebergPreview | null {
  if (!(input.totalAmount > 0)) return null;
  const seconds = input.duration.trim() ? parseDuration(input.duration) : null;
  const scheduled = scheduleCount(input, seconds);
  const sliceCount = input.sliceAmount > 0
    ? Math.max(1, Math.ceil(input.totalAmount / input.sliceAmount))
    : input.mode === "RANGE"
      ? Math.max(1, input.levels || 1)
      : scheduled ?? Math.max(1, input.levels || 1);
  const perSlice = input.sliceAmount > 0 ? input.sliceAmount : input.totalAmount / sliceCount;
  let intervalSeconds: number | null = null;
  if (seconds != null && input.scheduleInterval.trim()) {
    const parsed = parseDuration(input.scheduleInterval);
    if (parsed != null && scheduleSliceCount(seconds, parsed) != null) intervalSeconds = parsed;
  }
  const maxPrice =
    input.mode === "RANGE"
      ? input.priceHigh > 0
        ? input.priceHigh
        : null
      : input.limitPrice > 0
        ? input.limitPrice
        : null;
  return {
    total: input.totalAmount,
    perSlice,
    intervalSeconds,
    maxPrice,
    sliceCount,
    releaseCount: scheduled,
  };
}

/** A decimal the executor accepts, without binary float noise. */
export function decimalString(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toPrecision(12)));
}

/**
 * Price a percent preview is estimated from: the limit, or the range mid.
 * The executor measures a percent from the average fill, which can differ.
 */
export function exitReference(
  input: Pick<RangeIcebergInput, "mode" | "limitPrice" | "priceLow" | "priceHigh">,
): { price: number; label: string } | null {
  if (input.mode === "UP_TO") {
    return input.limitPrice > 0 ? { price: input.limitPrice, label: "limit" } : null;
  }
  if (input.priceLow > 0 && input.priceHigh > 0 && input.priceLow <= input.priceHigh) {
    return { price: (input.priceLow + input.priceHigh) / 2, label: "range mid" };
  }
  return null;
}

/**
 * Trigger for one side. Percent moves above the entry for a long take profit
 * and a short stop, and below it for a long stop and a short take profit.
 * An absolute price is the same number for both sides.
 */
export function exitTriggerPrice(
  side: "BUY" | "SELL",
  kind: ExitKind,
  exit: Pick<RangeIcebergExitInput, "trigger" | "percent" | "price">,
  reference: number,
): number | null {
  if (!(reference > 0)) return null;
  if (exit.trigger === "price") return exit.price > 0 ? exit.price : null;
  if (!(exit.percent > 0) || exit.percent >= 1) return null;
  const long = side === "BUY";
  const above = kind === "take_profit" ? long : !long;
  return reference * (above ? 1 + exit.percent : 1 - exit.percent);
}

export interface OpenIcebergStop {
  type?: string;
  side?: string;
  status?: string;
  trading_pair?: string;
  config?: Record<string, unknown> | null;
  custom_info?: Record<string, unknown> | null;
}

function finitePrice(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function samePrice(left: number, right: number): boolean {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) <= scale * 1e-8;
}

/** The stop price this create would send, or the percent estimated from the limit or mid. */
export function configuredStopPrice(input: RangeIcebergInput): number | null {
  const exit = input.stopLoss;
  if (!exit) return null;
  if (exit.trigger === "price") return exit.price > 0 ? exit.price : null;
  const reference = exitReference(input);
  if (!reference) return null;
  return exitTriggerPrice(input.side, "stop_loss", exit, reference.price);
}

function storedMode(source: OpenIcebergStop): string {
  const info = source.custom_info ?? {};
  const cfg = source.config ?? {};
  const raw = info.mode ?? cfg.mode ?? "RANGE";
  return String(raw).trim().replace(/[\s-]+/g, "_").toUpperCase();
}

function storedReference(source: OpenIcebergStop): number | null {
  const info = source.custom_info ?? {};
  const cfg = source.config ?? {};
  if (storedMode(source) === "UP_TO") return finitePrice(cfg.limit_price ?? info.limit_price);
  const low = finitePrice(cfg.price_low ?? info.price_low);
  const high = finitePrice(cfg.price_high ?? info.price_high);
  if (low != null && high != null && low <= high) return (low + high) / 2;
  return null;
}

function tradeSide(raw: unknown): "BUY" | "SELL" | null {
  const text = String(raw ?? "").replace(/^.*\./, "").trim().toUpperCase();
  if (text === "BUY" || text === "SELL") return text;
  return null;
}

function storedStopPrice(source: OpenIcebergStop): number | null {
  const info = source.custom_info ?? {};
  const cfg = source.config ?? {};
  const live = finitePrice(info.stop_loss_trigger_price);
  if (live != null) return live;
  const stop = cfg.stop_loss ?? info.stop_loss;
  if (!stop || typeof stop !== "object" || Array.isArray(stop)) return null;
  const row = stop as Record<string, unknown>;
  const price = finitePrice(row.price);
  if (price != null) return price;
  const percent = finitePrice(row.percent);
  if (percent == null || percent >= 1) return null;
  const side = tradeSide(source.side || cfg.side || info.side);
  const reference = storedReference(source);
  if (!side || reference == null) return null;
  return exitTriggerPrice(side, "stop_loss", { trigger: "percent", percent, price: 0 }, reference);
}

/**
 * Set when another running iceberg on this pair and side already uses this
 * stop price. Create stays off. The trading API returns 409 for that duplicate.
 */
export function sameStopPriceWarning(
  input: RangeIcebergInput,
  pair: string,
  executors: OpenIcebergStop[],
): string | null {
  const mine = configuredStopPrice(input);
  if (mine == null) return null;
  const side = input.side.toUpperCase();
  const clash = executors.some((ex) => {
    if (!(ex.type || "").toLowerCase().includes("range_iceberg")) return false;
    const status = (ex.status || "").toLowerCase();
    if (status !== "running" && status !== "active") return false;
    if ((ex.trading_pair || "") !== pair) return false;
    const theirsSide = String(ex.side || "").replace(/^.*\./, "").toUpperCase();
    if (theirsSide !== side) return false;
    const theirs = storedStopPrice(ex);
    return theirs != null && samePrice(mine, theirs);
  });
  if (!clash) return null;
  return `Another open iceberg on this side already uses stop ${formatTriggerPrice(mine)}. Create stays off. The trading API returns 409 and refuses two tiers with the same stop price.`;
}

export function formatTriggerPrice(price: number): string {
  if (!(price > 0) || !Number.isFinite(price)) return "";
  const precise = Number(price.toPrecision(8));
  if (precise >= 1000) return precise.toFixed(2);
  if (precise >= 1) return precise.toFixed(4);
  return String(precise);
}

/**
 * Long and short triggers for the form.
 * A percent is an estimate based on the limit or the range mid. An absolute
 * price is the trigger itself.
 */
export function exitPreviewText(
  kind: ExitKind,
  exit: RangeIcebergExitInput,
  reference: { price: number; label: string } | null,
): string {
  if (!reference) return "Set the entry or limit price to preview the trigger.";
  const basis = `${reference.label} ${formatTriggerPrice(reference.price)}`;
  const long = exitTriggerPrice("BUY", kind, exit, reference.price);
  const short = exitTriggerPrice("SELL", kind, exit, reference.price);
  if (long == null || short == null) {
    return exit.trigger === "percent"
      ? `Enter a percent to preview an estimate based on ${basis}.`
      : "Enter a price to preview the trigger.";
  }
  if (exit.trigger === "percent") {
    return `Estimate based on ${basis}: long ${formatTriggerPrice(long)}, short ${formatTriggerPrice(short)}.`;
  }
  return `Long ${formatTriggerPrice(long)}, short ${formatTriggerPrice(short)}.`;
}

function wholeCount(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function exitLabel(kind: ExitKind): string {
  return kind === "take_profit" ? "Take profit" : "Stop loss";
}

function triggerAboveEntry(kind: ExitKind, side: "BUY" | "SELL"): boolean {
  const long = side === "BUY";
  return kind === "take_profit" ? long : !long;
}

function validateExit(
  kind: ExitKind,
  exit: RangeIcebergExitInput,
  side: "BUY" | "SELL",
  reference: number | null,
): string | null {
  const label = exitLabel(kind);
  if (exit.trigger === "percent") {
    if (!(exit.percent > 0) || exit.percent >= 1) {
      return `${label} percent must be greater than 0 and less than 1`;
    }
  } else if (!(exit.price > 0)) {
    return `${label} price is required`;
  }
  if (reference != null && reference > 0) {
    const trigger = exit.trigger === "price"
      ? exit.price
      : exitTriggerPrice(side, kind, exit, reference);
    if (trigger != null) {
      const wantAbove = triggerAboveEntry(kind, side);
      const long = side === "BUY";
      if (wantAbove && !(trigger > reference)) {
        return `${label} must be above the entry for a ${long ? "long" : "short"}`;
      }
      if (!wantAbove && !(trigger < reference)) {
        return `${label} must be below the entry for a ${long ? "long" : "short"}`;
      }
    }
  }
  if (exit.execution !== "ICEBERG") return null;
  if (!wholeCount(exit.slices)) return `${label} slices must be a whole number of at least 1`;
  if (!wholeCount(exit.visibleCount)) {
    return `${label} visible count must be a whole number of at least 1`;
  }
  if (exit.visibleCount > exit.slices) return `${label} visible count cannot exceed slices`;
  if (exit.interval.trim()) {
    const seconds = parseDuration(exit.interval);
    if (seconds == null || !(seconds > 0)) {
      return `${label} interval must be seconds or a value like 30s`;
    }
  }
  const hasLimit = exit.priceStyle === "LIMIT";
  if (hasLimit) {
    if (!(exit.limitPrice > 0)) {
      return `${label} iceberg needs a limit price, or a price low and a price high`;
    }
  } else if (!(exit.priceLow > 0) || !(exit.priceHigh > 0)) {
    return `${label} iceberg needs a limit price, or a price low and a price high`;
  } else if (exit.priceLow > exit.priceHigh) {
    return `${label} price low must be at or below price high`;
  }
  if (kind === "stop_loss") {
    const trigger = exit.trigger === "price"
      ? exit.price
      : reference != null
        ? exitTriggerPrice(side, kind, exit, reference)
        : null;
    if (trigger != null && trigger > 0) {
      const bounds = stopBoundsMessage(exit, side, trigger);
      if (bounds) return bounds;
    }
  }
  return null;
}

/**
 * A long stop sells at or below its trigger. A short stop buys at or above it.
 * A bound on the other side would rest through the trigger.
 */
function stopBoundsMessage(
  exit: RangeIcebergExitInput,
  side: "BUY" | "SELL",
  trigger: number,
): string | null {
  const long = side === "BUY";
  const slack = Math.max(Math.abs(trigger) * 1e-6, 1e-10);
  const onSide = (price: number) => (long ? price <= trigger + slack : price >= trigger - slack);
  const direction = long ? "at or below" : "at or above";
  const which = long ? "long" : "short";
  if (exit.priceStyle === "LIMIT") {
    if (exit.limitPrice > 0 && !onSide(exit.limitPrice)) {
      return `Stop loss limit must be ${direction} the trigger for a ${which}`;
    }
    return null;
  }
  const lowOff = exit.priceLow > 0 && !onSide(exit.priceLow);
  const highOff = exit.priceHigh > 0 && !onSide(exit.priceHigh);
  if (lowOff || highOff) {
    return `Stop loss price bounds must be ${direction} the trigger for a ${which}`;
  }
  return null;
}

function validateExits(input: RangeIcebergInput): string | null {
  const take = input.takeProfit ?? null;
  const stop = input.stopLoss ?? null;
  if (!take && !stop) return null;
  if (input.reduceOnly) {
    return "Take profit and stop loss cannot be set when reduce only is on";
  }
  const reference = exitReference(input)?.price ?? null;
  if (take) {
    const message = validateExit("take_profit", take, input.side, reference);
    if (message) return message;
  }
  if (stop) {
    const message = validateExit("stop_loss", stop, input.side, reference);
    if (message) return message;
  }
  if (
    take &&
    stop &&
    take.trigger === "price" &&
    stop.trigger === "price" &&
    take.price > 0 &&
    stop.price > 0
  ) {
    if (input.side === "BUY" && !(stop.price < take.price)) {
      return "Stop loss price must be below the take profit price for a long";
    }
    if (input.side === "SELL" && !(stop.price > take.price)) {
      return "Stop loss price must be above the take profit price for a short";
    }
  }
  return rangeBoundMessage(input);
}

/**
 * A range fill can land at either end. An absolute stop inside the band can
 * fire while the ladder is still working, and a later edit then rejects it.
 * An absolute take profit has to clear the worst fill, or the executor skips it.
 */
function rangeBoundMessage(input: RangeIcebergInput): string | null {
  if (input.mode !== "RANGE") return null;
  const take = input.takeProfit ?? null;
  const stop = input.stopLoss ?? null;
  if (take?.trigger === "price" && take.price > 0) {
    if (input.side === "BUY" && input.priceHigh > 0 && !(take.price > input.priceHigh)) {
      return "Take profit price must be above price high. A fill at the top of the range would leave it at or below the average";
    }
    if (input.side === "SELL" && input.priceLow > 0 && !(take.price < input.priceLow)) {
      return "Take profit price must be below price low. A fill at the bottom of the range would leave it at or above the average";
    }
  }
  if (stop?.trigger === "price" && stop.price > 0) {
    if (input.side === "BUY" && input.priceLow > 0 && !(stop.price < input.priceLow)) {
      return "Stop loss price must be below price low, or it can fire while the ladder is still buying";
    }
    if (input.side === "SELL" && input.priceHigh > 0 && !(stop.price > input.priceHigh)) {
      return "Stop loss price must be above price high, or it can fire while the ladder is still selling";
    }
  }
  return null;
}

/** Shown for an up-to absolute take profit. The average can still miss it. */
export function upToTakeProfitNote(input: RangeIcebergInput): string | null {
  const take = input.takeProfit ?? null;
  if (input.mode !== "UP_TO" || take?.trigger !== "price" || !(take.price > 0)) return null;
  return "An up-to fill can land on either side of the limit. If the average is not past this price, the take profit is skipped.";
}

function exitPayload(kind: ExitKind, exit: RangeIcebergExitInput): Record<string, unknown> {
  const body: Record<string, unknown> = { execution: exit.execution };
  if (exit.trigger === "percent") body.percent = decimalString(exit.percent);
  else body.price = decimalString(exit.price);
  if (exit.execution === "SINGLE") {
    body.order_type = kind === "stop_loss" ? "MARKET" : exit.orderType;
    return body;
  }
  body.slices = exit.slices;
  body.visible_count = exit.visibleCount;
  if (exit.interval.trim()) body.interval = exit.interval.trim();
  if (exit.priceStyle === "LIMIT") body.limit_price = decimalString(exit.limitPrice);
  else {
    body.price_low = decimalString(exit.priceLow);
    body.price_high = decimalString(exit.priceHigh);
  }
  // A stop iceberg rests at its own cap. The entry WAIT setting does not apply.
  if (kind === "stop_loss") body.cap_behavior = "REST_AT_CAP";
  return body;
}

/** The exit object a range iceberg create or edit sends. */
export function rangeIcebergExitConfig(
  kind: ExitKind,
  exit: RangeIcebergExitInput,
): Record<string, unknown> {
  return exitPayload(kind, exit);
}

/** Take profit and stop loss rules, without the entry fields around them. */
export function validateRangeIcebergExits(input: RangeIcebergInput): string | null {
  return validateExits(input);
}

/** The first rule the config would reject, or null when the create can proceed. */
export function validateRangeIceberg(input: RangeIcebergInput): string | null {
  if (!(input.totalAmount > 0)) return "Total amount is required";
  if (input.mode === "RANGE") {
    if (!(input.priceLow > 0) || !(input.priceHigh > 0)) {
      return "Price low and price high are required";
    }
    if (input.priceLow > input.priceHigh) return "Price low must be at or below price high";
  } else if (!(input.limitPrice > 0)) {
    return "Limit price is required";
  }
  if (!(input.levels >= 1)) return "Levels must be at least 1";
  if (!(input.visibleCount >= 1)) return "Visible count must be at least 1";
  if (input.mode === "RANGE" && input.visibleCount > input.levels) {
    return "Visible count cannot exceed levels";
  }
  if (input.sliceAmount > 0 && input.sliceAmount > input.totalAmount) {
    return "Slice amount cannot exceed the total";
  }
  if (input.sizeJitterPct < 0 || input.priceJitterPct < 0 || input.timingJitterPct < 0) {
    return "Jitter cannot be negative";
  }
  if (input.sizeJitterPct > 1) return "Size jitter cannot exceed 100%";
  if (input.priceJitterPct > 1) return "Price jitter cannot exceed 100%";
  if (input.timingJitterPct > 1) return "Timing jitter cannot exceed 100%";
  if (input.minOrderInterval < 0) return "Minimum order interval cannot be negative";
  if (!(input.leverage >= 1)) return "Leverage must be at least 1";
  if (input.weight < -1 || input.weight > 1) return "Weight must be between -1 and 1";
  const hasDuration = input.duration.trim().length > 0;
  const durationSeconds = hasDuration ? parseDuration(input.duration) : null;
  if (hasDuration && durationSeconds == null) {
    return "Duration must be seconds or a value like 30m, 24h, 1d";
  }
  const hasInterval = input.scheduleInterval.trim().length > 0;
  const intervalSeconds = hasInterval ? parseDuration(input.scheduleInterval) : null;
  if (hasInterval && intervalSeconds == null) {
    return "Schedule interval must be seconds or a value like 30s";
  }
  if (hasInterval && intervalSeconds != null && !(intervalSeconds > 0)) {
    return "Schedule interval must be greater than 0";
  }
  if (hasDuration && !hasInterval) {
    return "A duration needs a schedule interval";
  }
  if (!hasDuration && hasInterval) {
    return "A schedule needs a duration";
  }
  if (
    durationSeconds != null &&
    intervalSeconds != null &&
    intervalSeconds > durationSeconds
  ) {
    return "Schedule interval cannot be longer than the duration";
  }
  if (input.expiry.trim()) {
    const expiry = parseDuration(input.expiry);
    if (expiry == null) return "Expiry must be seconds or a value like 30m, 24h, 1d";
    if (!(expiry > 0)) return "Expiry must be greater than 0";
  } else if (input.expirySeconds < 0) {
    return "Expiry cannot be negative";
  }
  if (input.maxSlippage < 0) return "Max slippage cannot be negative";
  if (input.randomSeed.trim() && !/^-?\d+$/.test(input.randomSeed.trim())) {
    return "Random seed must be an integer";
  }
  return validateExits(input);
}

export interface IcebergSent {
  /** Amount in `sizeUnit` that the create sends. */
  total: number;
  sizeUnit: SizeUnit;
  /** Base the ladder would place, or the limit estimate for an up-to order. */
  baseTotal: number;
  /** Quote the order spends, when it is known. */
  quoteTotal: number | null;
  /** Rungs a range kept after rounding. Null for an up-to order. */
  rungs: number | null;
  error: string | null;
}

function failedSent(message: string): IcebergSent {
  return { total: 0, sizeUnit: "BASE", baseTotal: 0, quoteTotal: null, rungs: null, error: message };
}

function ladderFor(input: RangeIcebergInput, rule: SizeRule | null, total: number): RangeLadder {
  return buildRangeLadder({
    total,
    unit: input.sizeUnit,
    priceLow: input.priceLow,
    priceHigh: input.priceHigh,
    levels: Math.max(1, Math.trunc(input.levels) || 1),
    distribution: input.distribution,
    weight: input.weight,
    side: input.side,
    priceStep: rule?.priceIncrement ?? 0,
    amountStep: orderStep(rule),
    minAmount: rule?.minOrderSize ?? 0,
    contractSize: rule?.contractSize,
  });
}

/**
 * Shrink a quote total until the ladder's base fits `maxBase`.
 * Each pass rebuilds, because rounding is not linear.
 */
function fitQuoteToBase(
  input: RangeIcebergInput,
  rule: SizeRule | null,
  maxBase: number,
): { quote: number; ladder: RangeLadder } {
  let quote = input.totalAmount;
  let ladder = ladderFor(input, rule, quote);
  for (let pass = 0; pass < 8 && ladder.baseTotal > maxBase + 1e-9; pass += 1) {
    if (!(ladder.baseTotal > 0)) break;
    quote = Number((quote * (maxBase / ladder.baseTotal)).toPrecision(12));
    ladder = ladderFor(input, rule, quote);
  }
  if (ladder.baseTotal > maxBase + 1e-9) {
    throw new Error("The close is below the minimum order size");
  }
  return { quote, ladder };
}

/**
 * The size the create will send.
 *
 * A quote range keeps the typed total and `size_unit` QUOTE. The ladder
 * converts each rung. An up-to quote order does the same, and the base figure
 * is the total divided by the limit. A close cap shrinks that quote so the
 * ladder, or the limit estimate, does not exceed the open base size.
 * Contracts need a second confirm and are floored to whole contracts.
 * `price` is only a fallback when an up-to order has no limit yet.
 */
export function icebergSentSize(
  input: RangeIcebergInput,
  rule: SizeRule | null,
  price: number,
  contractsConfirmed: boolean,
  maxBase = 0,
): IcebergSent {
  if (!(input.totalAmount > 0)) return failedSent("Total amount is required");
  if (input.sizeUnit === "CONTRACTS" && !contractsConfirmed) {
    return failedSent("Confirm that this size is in contracts, not base coins");
  }
  if (input.sizeUnit === "CONTRACTS" && !(rule?.contractSize && rule.contractSize > 0)) {
    return failedSent("Contract size is not known, so this order was not sent");
  }

  if (input.sizeUnit === "CONTRACTS" && rule?.contractSize) {
    let contracts = Math.floor(input.totalAmount + 1e-9);
    if (maxBase > 0) {
      const maxContracts = Math.floor(maxBase / rule.contractSize + 1e-9);
      if (contracts > maxContracts) contracts = maxContracts;
    }
    if (contracts < 1) return failedSent("Each slice must be at least 1 after the 1 step");
    const sized = { ...input, totalAmount: contracts };
    if (input.mode === "RANGE") {
      try {
        const ladder = ladderFor(sized, rule, contracts);
        return {
          total: contracts,
          sizeUnit: "CONTRACTS",
          baseTotal: ladder.baseTotal,
          quoteTotal: null,
          rungs: ladder.levels.length,
          error: null,
        };
      } catch (error) {
        return failedSent(error instanceof Error ? error.message : "The range ladder is below the minimum order size after rounding.");
      }
    }
    return {
      total: contracts,
      sizeUnit: "CONTRACTS",
      baseTotal: Number((contracts * rule.contractSize).toPrecision(12)),
      quoteTotal: null,
      rungs: null,
      error: null,
    };
  }

  if (input.mode === "RANGE") {
    try {
      let total = input.totalAmount;
      let ladder: RangeLadder;
      if (input.sizeUnit === "QUOTE" && maxBase > 0) {
        const fitted = fitQuoteToBase(input, rule, maxBase);
        total = fitted.quote;
        ladder = fitted.ladder;
      } else {
        if (input.sizeUnit === "BASE" && maxBase > 0 && total > maxBase) total = maxBase;
        ladder = ladderFor(input, rule, total);
      }
      return {
        total,
        sizeUnit: input.sizeUnit,
        baseTotal: ladder.baseTotal,
        quoteTotal: input.sizeUnit === "QUOTE" ? total : ladder.quoteTotal,
        rungs: ladder.levels.length,
        error: null,
      };
    } catch (error) {
      return failedSent(error instanceof Error ? error.message : "The range ladder is below the minimum order size after rounding.");
    }
  }

  const limit = input.limitPrice > 0 ? input.limitPrice : price;
  if (input.sizeUnit === "QUOTE") {
    if (!(limit > 0)) return failedSent("A price is required to convert quote size");
    let total = input.totalAmount;
    if (maxBase > 0 && total / limit > maxBase) total = Number((maxBase * limit).toPrecision(12));
    return {
      total,
      sizeUnit: "QUOTE",
      baseTotal: Number((total / limit).toPrecision(12)),
      quoteTotal: total,
      rungs: null,
      error: null,
    };
  }
  let total = input.totalAmount;
  if (maxBase > 0 && total > maxBase) total = maxBase;
  const step = orderStep(rule);
  if (step > 0) total = floorBaseAmount(total, step);
  const min = rule?.minOrderSize ?? 0;
  if (!(total > 0) || (min > 0 && total < min)) {
    return failedSent(`Each slice must be at least ${min} after the ${step || 1} step`);
  }
  return {
    total,
    sizeUnit: "BASE",
    baseTotal: total,
    quoteTotal: limit > 0 ? Number((total * limit).toPrecision(12)) : null,
    rungs: null,
    error: null,
  };
}

/** The `config` body for `POST /executors/` with `executor_type: range_iceberg_executor`. */
export function rangeIcebergConfig(
  input: RangeIcebergInput,
  connector: string,
  pair: string,
  includeMargin = false,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    connector_name: connector,
    trading_pair: pair,
    side: input.side,
    total_amount: input.totalAmount,
    size_unit: input.sizeUnit,
    mode: input.mode,
    cap_behavior: input.capBehavior,
    levels: input.levels,
    distribution: input.distribution,
    weight: input.weight,
    post_only: input.postOnly,
    iceberg: input.iceberg,
    visible_count: input.visibleCount,
    min_order_interval: input.minOrderInterval,
    catch_up: input.catchUp,
    reduce_only: input.reduceOnly,
    leverage: input.leverage,
  };
  if (includeMargin) config.margin_mode = input.marginMode;
  if (input.mode === "RANGE") {
    config.price_low = input.priceLow;
    config.price_high = input.priceHigh;
  } else {
    config.limit_price = input.limitPrice;
  }
  if (input.sliceAmount > 0) config.slice_amount = input.sliceAmount;
  if (input.sizeJitterPct > 0) config.size_jitter_pct = input.sizeJitterPct;
  if (input.priceJitterPct > 0) config.price_jitter_pct = input.priceJitterPct;
  if (input.timingJitterPct > 0) config.timing_jitter_pct = input.timingJitterPct;
  const expirySeconds = input.expiry.trim() ? parseDuration(input.expiry) : input.expirySeconds;
  if (expirySeconds != null && expirySeconds > 0) config.expiry_seconds = expirySeconds;
  if (input.maxSlippage > 0) config.max_slippage = input.maxSlippage;
  if (input.randomSeed.trim()) config.random_seed = Number(input.randomSeed.trim());
  if (input.duration.trim()) {
    config.duration = input.duration.trim();
    if (input.scheduleInterval.trim()) config.schedule_interval = input.scheduleInterval.trim();
    config.schedule_start = input.scheduleStart;
  }
  if (input.takeProfit) config.take_profit = exitPayload("take_profit", input.takeProfit);
  if (input.stopLoss) config.stop_loss = exitPayload("stop_loss", input.stopLoss);
  if (input.takeProfit || input.stopLoss) config.exit_arming = input.exitArming ?? "ON_FULL_FILL";
  return config;
}

/**
 * The line under the interval field.
 *
 * Null when no duration is set: the whole size goes out at once. A quote
 * range passes `baseTotal` from the ladder so the base figure is the sum of
 * the rungs, not the total divided by one price. While the market is outside
 * the range, Carry places a missed slice later and Skip drops it. An order
 * already on the book is left to fill.
 */
export function scheduleNote(args: {
  duration: string;
  interval: string;
  total: number;
  unit: SizeUnit;
  baseSymbol: string;
  quoteSymbol: string;
  price: number | null;
  catchUp: CatchUp;
  /** Ladder base for the whole order. Used instead of `total / price`. */
  baseTotal?: number | null;
}): string | null {
  if (!args.duration.trim()) return null;
  const seconds = parseDuration(args.duration);
  const intervalSeconds = parseDuration(args.interval);
  if (seconds == null || intervalSeconds == null) return null;
  const count = scheduleSliceCount(seconds, intervalSeconds);
  if (count == null) return null;
  const every = formatInterval(intervalSeconds);
  const pieces = [`${count} ${count === 1 ? "slice" : "slices"}`];
  if (args.total > 0) {
    const per = args.total / count;
    const symbol = args.unit === "QUOTE"
      ? args.quoteSymbol
      : args.unit === "CONTRACTS"
        ? "contracts"
        : args.baseSymbol;
    const amount = [formatTokenAmount(per), symbol].filter(Boolean).join(" ");
    let other = "";
    if (args.unit === "QUOTE" && args.baseTotal != null && args.baseTotal > 0 && args.baseSymbol) {
      const converted = Number((args.baseTotal / count).toPrecision(12));
      other = ` (\u2248 ${formatTokenAmount(converted)} ${args.baseSymbol})`;
    } else if (args.price != null && args.price > 0 && args.unit !== "CONTRACTS") {
      const converted = Number((args.unit === "QUOTE" ? per / args.price : per * args.price).toPrecision(12));
      const otherSymbol = args.unit === "QUOTE" ? args.baseSymbol : args.quoteSymbol;
      if (otherSymbol) other = ` (\u2248 ${formatTokenAmount(converted)} ${otherSymbol})`;
    }
    pieces.push(`about ${amount}${other}`);
  }
  const sentences = [`${pieces.join(", ")} every ${every}`];
  if (scheduleHasRemainder(seconds, intervalSeconds)) {
    sentences.push("The last part of the duration gets no new slice");
  }
  if (count > 1) {
    sentences.push(
      args.catchUp === "SKIP"
        ? "While the market is outside the range, a missed slice is dropped. An order already on the book is left to fill"
        : "While the market is outside the range, a missed slice is placed later. An order already on the book is left to fill",
    );
  }
  return `${sentences.join(". ")}.`;
}

/** The executor's default protective stop buffer. The form does not send an override. */
export const PROTECTIVE_STOP_BUFFER = 0.005;
/** The executor's default quiet time before a stop iceberg markets the rest. */
export const STOP_FALLBACK_SECONDS = 30;

/** Exchange stop: long trigger * (1 - buffer), short trigger * (1 + buffer). */
export function exchangeStopPrice(side: "BUY" | "SELL", trigger: number): number | null {
  if (!(trigger > 0)) return null;
  const price = side === "BUY"
    ? trigger * (1 - PROTECTIVE_STOP_BUFFER)
    : trigger * (1 + PROTECTIVE_STOP_BUFFER);
  return Number(price.toPrecision(12));
}

export function stopProtectionText(side: "BUY" | "SELL", trigger: number | null): string {
  const exchange = trigger != null ? exchangeStopPrice(side, trigger) : null;
  const price = exchange != null ? ` at ${formatTokenAmount(exchange)}` : "";
  return `The exchange stop rests${price}, 0.5% past this trigger. If a stop iceberg gets no fill for ${STOP_FALLBACK_SECONDS}s, the rest is a market order.`;
}

/** One line for the jitter the children will use. Null when every jitter is 0. */
export function jitterNote(input: Pick<RangeIcebergInput, "sizeJitterPct" | "priceJitterPct" | "timingJitterPct">): string | null {
  const parts: string[] = [];
  if (input.sizeJitterPct > 0) parts.push(`${formatTokenAmount(input.sizeJitterPct * 100)}% size`);
  if (input.priceJitterPct > 0) parts.push(`${formatTokenAmount(input.priceJitterPct * 100)}% price`);
  if (input.timingJitterPct > 0) parts.push(`${formatTokenAmount(input.timingJitterPct * 100)}% timing`);
  if (!parts.length) return null;
  const exit = input.priceJitterPct > 0 ? " Exit icebergs reuse this price jitter." : "";
  return `Each child can vary by ${parts.join(", ")}.${exit}`;
}

export function formatInterval(seconds: number | null): string {
  if (seconds == null) return "all at once";
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  const rounded = Number(seconds.toPrecision(4));
  return `${rounded}s`;
}
