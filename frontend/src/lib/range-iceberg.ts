import { floorBaseAmount, type SizeRule } from "./order-size";

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
  scheduleSlices: number;
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

function scheduleCount(input: RangeIcebergInput, seconds: number | null): number | null {
  if (seconds == null) return null;
  if (input.scheduleSlices >= 1) return input.scheduleSlices;
  const interval = parseDuration(input.scheduleInterval);
  if (interval != null && interval > 0) return Math.max(1, Math.floor(seconds / interval));
  return null;
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
  if (seconds != null && input.scheduleSlices >= 1) {
    intervalSeconds = seconds / input.scheduleSlices;
  } else if (seconds != null && input.scheduleInterval.trim()) {
    intervalSeconds = parseDuration(input.scheduleInterval);
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
  if (hasDuration && parseDuration(input.duration) == null) {
    return "Duration must be seconds or a value like 30m, 24h, 1d";
  }
  const hasSlices = input.scheduleSlices >= 1;
  const hasInterval = input.scheduleInterval.trim().length > 0;
  if (hasInterval && parseDuration(input.scheduleInterval) == null) {
    return "Schedule interval must be seconds or a value like 30s";
  }
  if (hasDuration && !hasSlices && !hasInterval) {
    return "A duration needs schedule slices or a schedule interval";
  }
  if (hasDuration && hasSlices && hasInterval) {
    return "Set either schedule slices or a schedule interval, not both";
  }
  if (!hasDuration && (hasSlices || hasInterval)) {
    return "A schedule needs a duration";
  }
  if (input.expirySeconds < 0) return "Expiry cannot be negative";
  if (input.maxSlippage < 0) return "Max slippage cannot be negative";
  if (input.randomSeed.trim() && !/^-?\d+$/.test(input.randomSeed.trim())) {
    return "Random seed must be an integer";
  }
  return null;
}

export interface IcebergSent {
  total: number;
  perSlice: number;
  sliceCount: number;
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
  let baseTotal = input.totalAmount;
  if (input.sizeUnit === "QUOTE") {
    if (!(price > 0)) {
      return { ...raw, error: "A price is required to convert quote size" };
    }
    baseTotal = input.totalAmount / price;
  }
  if (maxBase > 0 && baseTotal > maxBase) baseTotal = maxBase;
  const step = input.sizeUnit === "CONTRACTS" ? 1 : rule?.increment ?? 0;
  const min = input.sizeUnit === "CONTRACTS" ? 1 : rule?.minOrderSize ?? 0;
  if (!(step > 0)) {
    return { total: input.totalAmount, perSlice: raw.perSlice, sliceCount: raw.sliceCount, error: null };
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
  if (input.sizeUnit === "QUOTE") {
    return {
      total: Number((sentBase * price).toPrecision(12)),
      perSlice: Number((child * price).toPrecision(12)),
      sliceCount: raw.sliceCount,
      error: null,
    };
  }
  return { total: sentBase, perSlice: child, sliceCount: raw.sliceCount, error: null };
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
    if (input.scheduleSlices >= 1) config.schedule_slices = input.scheduleSlices;
    else if (input.scheduleInterval.trim()) config.schedule_interval = input.scheduleInterval.trim();
  }
  return config;
}

export function formatInterval(seconds: number | null): string {
  if (seconds == null) return "all at once";
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  const rounded = Number(seconds.toPrecision(4));
  return `${rounded}s`;
}
