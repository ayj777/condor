import { floorBaseAmount, formatTokenAmount, orderStep, type SizeRule } from "./order-size";

/**
 * Client-side twin of `RangeIcebergExecutorConfig`.
 *
 * The validator on the Hummingbot side is the one that rejects a create. This
 * module repeats its rules so the form can say why before the POST, and so the
 * preview (total, per-slice size, interval, max price) matches the executor's
 * own slice math: an explicit slice, else the schedule's count, else `levels`.
 */

export type RangeMode = "RANGE" | "UP_TO";
export type SizeUnit = "BASE" | "QUOTE" | "CONTRACTS";
export type CapBehavior = "REST_AT_CAP" | "WAIT";
export type Distribution = "LINEAR" | "GEOMETRIC" | "WEIGHTED";
export type CatchUp = "CARRY" | "SKIP";
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
  sliceCount: number;
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

/** The preview the form shows. Null until a total has been entered. */
export function rangeIcebergPreview(input: RangeIcebergInput): RangeIcebergPreview | null {
  if (!(input.totalAmount > 0)) return null;
  const seconds = input.duration.trim() ? parseDuration(input.duration) : null;
  const scheduled = scheduleCount(input, seconds);
  const sliceCount =
    input.sliceAmount > 0
      ? Math.max(1, Math.ceil(input.totalAmount / input.sliceAmount))
      : scheduled ?? Math.max(1, input.levels || 1);
  const perSlice =
    input.sliceAmount > 0 ? input.sliceAmount : input.totalAmount / sliceCount;
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
  return { total: input.totalAmount, perSlice, intervalSeconds, maxPrice, sliceCount };
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
  return null;
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
  if (input.expirySeconds < 0) return "Expiry cannot be negative";
  if (input.maxSlippage < 0) return "Max slippage cannot be negative";
  if (input.randomSeed.trim() && !/^-?\d+$/.test(input.randomSeed.trim())) {
    return "Random seed must be an integer";
  }
  return validateExits(input);
}

export interface IcebergSent {
  total: number;
  perSlice: number;
  sliceCount: number;
  /** BASE after a quote conversion, so the executor does not convert again. */
  sizeUnit?: "BASE" | "QUOTE" | "CONTRACTS";
  error: string | null;
}

/**
 * The size the create will send.
 *
 * Every child is floored to the step. The total is that child times the
 * slice count, so the preview and the payload match. Quote is converted to
 * base with `price` before the floor. Contracts need a second confirm and
 * are floored to whole contracts.
 */
export function icebergSentSize(
  input: RangeIcebergInput,
  rule: SizeRule | null,
  price: number,
  contractsConfirmed: boolean,
  maxBase = 0,
): IcebergSent {
  const raw = rangeIcebergPreview(input);
  if (!raw) {
    return { total: 0, perSlice: 0, sliceCount: 0, error: "Total amount is required" };
  }
  if (input.sizeUnit === "CONTRACTS" && !contractsConfirmed) {
    return {
      total: raw.total,
      perSlice: raw.perSlice,
      sliceCount: raw.sliceCount,
      error: "Confirm that this size is in contracts, not base coins",
    };
  }
  if (input.sizeUnit === "CONTRACTS" && !(rule?.contractSize && rule.contractSize > 0)) {
    return {
      total: 0,
      perSlice: 0,
      sliceCount: raw.sliceCount,
      error: "Contract size is not known, so this order was not sent",
    };
  }
  let baseTotal = input.totalAmount;
  if (input.sizeUnit === "QUOTE") {
    if (!(price > 0)) {
      return { ...raw, error: "A price is required to convert quote size" };
    }
    baseTotal = input.totalAmount / price;
  }
  if (input.sizeUnit === "CONTRACTS" && rule?.contractSize && maxBase > 0) {
    const maxContracts = Math.floor(maxBase / rule.contractSize + 1e-9);
    if (baseTotal > maxContracts) baseTotal = maxContracts;
  } else if (maxBase > 0 && baseTotal > maxBase) {
    baseTotal = maxBase;
  }
  const step = input.sizeUnit === "CONTRACTS" ? 1 : orderStep(rule);
  const min = input.sizeUnit === "CONTRACTS" ? 1 : rule?.minOrderSize ?? 0;
  if (!(step > 0)) {
    if (input.sizeUnit === "QUOTE") {
      return {
        total: baseTotal,
        perSlice: baseTotal / raw.sliceCount,
        sliceCount: raw.sliceCount,
        sizeUnit: "BASE",
        error: null,
      };
    }
    const total = maxBase > 0 && input.totalAmount > maxBase ? maxBase : input.totalAmount;
    return {
      total,
      perSlice: total / raw.sliceCount,
      sliceCount: raw.sliceCount,
      sizeUnit: input.sizeUnit,
      error: null,
    };
  }
  const child = floorBaseAmount(baseTotal / raw.sliceCount, step);
  if (!(child > 0) || (min > 0 && child < min)) {
    return {
      total: 0,
      perSlice: 0,
      sliceCount: raw.sliceCount,
      error: `Each slice must be at least ${min} after the ${step} step`,
    };
  }
  const sentBase = Number((child * raw.sliceCount).toPrecision(12));
  return {
    total: sentBase,
    perSlice: child,
    sliceCount: raw.sliceCount,
    sizeUnit: input.sizeUnit === "CONTRACTS" ? "CONTRACTS" : "BASE",
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
  if (input.expirySeconds > 0) config.expiry_seconds = input.expirySeconds;
  if (input.maxSlippage > 0) config.max_slippage = input.maxSlippage;
  if (input.randomSeed.trim()) config.random_seed = Number(input.randomSeed.trim());
  if (input.duration.trim()) {
    config.duration = input.duration.trim();
    if (input.scheduleInterval.trim()) config.schedule_interval = input.scheduleInterval.trim();
  }
  if (input.takeProfit) config.take_profit = exitPayload("take_profit", input.takeProfit);
  if (input.stopLoss) config.stop_loss = exitPayload("stop_loss", input.stopLoss);
  if (input.takeProfit || input.stopLoss) config.exit_arming = input.exitArming ?? "ON_FULL_FILL";
  return config;
}

/**
 * The line under the interval field.
 *
 * Null when no duration is set: the whole size goes out at once, so there is
 * nothing to spell out. Quote and base are both shown when a price can
 * convert them. CARRY adds unfilled size to the next interval. SKIP leaves
 * that size behind.
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
    if (args.price != null && args.price > 0 && args.unit !== "CONTRACTS") {
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
        ? "Unfilled size is left behind. The next interval releases only its own share"
        : "Unfilled size carries into the next interval",
    );
  }
  return `${sentences.join(". ")}.`;
}

export function formatInterval(seconds: number | null): string {
  if (seconds == null) return "all at once";
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  const rounded = Number(seconds.toPrecision(4));
  return `${rounded}s`;
}
