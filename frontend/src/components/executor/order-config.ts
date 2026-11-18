// ── Order executor state machine ──
//
// See position-config.ts: state and reducer live beside the panel, not inside
// it, so this module can export what the page and the tests reach for.

import { useEffect, useMemo, useReducer } from "react";

import type { ChartPriceMapping, ExecutorValidation, ExtraLine, PickSlot } from "./types";
import { loadPersistedDefaults, savePersistedDefaults } from "./persisted-defaults";
import { ORDER_DEFAULTS_KEY } from "@/lib/sessionState";
import { legalBaseAmount, quantizePrice, type SizeRule } from "@/lib/order-size";
import {
  exitReference,
  exitTriggerPrice,
  icebergSentSize,
  rangeIcebergConfig,
  validateRangeIceberg,
  type ExitExecution,
  type ExitOrderType,
  type ExitPriceStyle,
  type ExitTrigger,
  type RangeIcebergExitInput,
  type RangeIcebergInput,
} from "@/lib/range-iceberg";
import { marginForOpen } from "@/lib/trade-guards";

// ── State ──

export interface OrderState {
  side: 1 | 2;
  amount: number;
  execution_strategy: string;
  price: number;
  leverage: number;
  /** Kept so a saved form still loads. Create does not call set_leverage from it. */
  leverageExplicit: boolean;
  /** True after the user types a leverage. Apply stays off until then. */
  leverageTouched: boolean;
  /** True after the user edits the margin mode. A flat side still sends the displayed mode. */
  marginExplicit: boolean;
  chaser_distance: number;
  chaser_refresh_threshold: number;
  position_action: string;
  activePickField: string | null;
  /** Whether this market's price has already been offered to `price`; see PositionState. */
  anchored: boolean;
  // Range iceberg. Prices are not persisted: they belong to the market that is open.
  ri_mode: "RANGE" | "UP_TO";
  ri_total_amount: number;
  ri_size_unit: "BASE" | "QUOTE";
  ri_price_low: number;
  ri_price_high: number;
  ri_limit_price: number;
  ri_iceberg: boolean;
  ri_visible_count: number;
  ri_levels: number;
  ri_duration: string;
  ri_schedule_slices: number;
  ri_schedule_interval: string;
  ri_catch_up: "CARRY" | "SKIP";
  ri_cap_behavior: "REST_AT_CAP" | "WAIT";
  ri_margin_mode: "ISOLATED" | "CROSS";
  ri_reduce_only: boolean;
  /** A second confirm, required before a CONTRACTS size is sent. Not persisted. */
  ri_contracts_confirmed: boolean;
  ri_distribution: "LINEAR" | "GEOMETRIC" | "WEIGHTED";
  ri_weight: number;
  ri_post_only: boolean;
  ri_slice_amount: number;
  ri_size_jitter_pct: number;
  ri_price_jitter_pct: number;
  ri_timing_jitter_pct: number;
  ri_min_order_interval: number;
  ri_expiry_seconds: number;
  ri_max_slippage: number;
  ri_random_seed: string;
  ri_show_advanced: boolean;
  // Exits stay off until the user turns one on, and a disabled exit is omitted.
  ri_exit_arming: "ON_FULL_FILL" | "ON_ANY_FILL";
  ri_tp_enabled: boolean;
  ri_tp_trigger: ExitTrigger;
  ri_tp_percent: number;
  ri_tp_price: number;
  ri_tp_execution: ExitExecution;
  ri_tp_order_type: ExitOrderType;
  ri_tp_slices: number;
  ri_tp_visible_count: number;
  ri_tp_interval: string;
  ri_tp_price_style: ExitPriceStyle;
  ri_tp_limit_price: number;
  ri_tp_price_low: number;
  ri_tp_price_high: number;
  ri_sl_enabled: boolean;
  ri_sl_trigger: ExitTrigger;
  ri_sl_percent: number;
  ri_sl_price: number;
  ri_sl_execution: ExitExecution;
  ri_sl_slices: number;
  ri_sl_visible_count: number;
  ri_sl_interval: string;
  ri_sl_price_style: ExitPriceStyle;
  ri_sl_limit_price: number;
  ri_sl_price_low: number;
  ri_sl_price_high: number;
}

/** Exit prices follow the market tick. They are not a remembered preference. */
const EXIT_PRICE_FIELDS = [
  "ri_tp_price",
  "ri_tp_limit_price",
  "ri_tp_price_low",
  "ri_tp_price_high",
  "ri_sl_price",
  "ri_sl_limit_price",
  "ri_sl_price_low",
  "ri_sl_price_high",
] as const satisfies readonly (keyof OrderState)[];

const EXIT_PICK_FIELDS = new Set<string>(EXIT_PRICE_FIELDS);

export type OrderAction =
  | { type: "SET_FIELD"; field: string; value: unknown }
  | { type: "SET_CONNECTOR"; value: string }
  | { type: "SET_PAIR"; value: string }
  | { type: "ANCHOR"; price: number }
  | { type: "ADOPT_LEVERAGE"; value: number }
  | { type: "QUANTIZE"; increment: number };

export const ORDER_DEFAULTS: OrderState = {
  side: 1,
  amount: 0,
  execution_strategy: "LIMIT",
  price: 0,
  leverage: 1,
  leverageExplicit: false,
  leverageTouched: false,
  marginExplicit: false,
  chaser_distance: 0.0005,
  chaser_refresh_threshold: 0.001,
  position_action: "OPEN",
  activePickField: null,
  anchored: false,
  ri_mode: "RANGE",
  ri_total_amount: 0,
  // The connector converts base size by the contract size. The form speaks base.
  ri_size_unit: "BASE",
  ri_price_low: 0,
  ri_price_high: 0,
  ri_limit_price: 0,
  ri_iceberg: false,
  ri_visible_count: 1,
  ri_levels: 10,
  ri_duration: "",
  ri_schedule_slices: 0,
  ri_schedule_interval: "",
  ri_catch_up: "CARRY",
  ri_cap_behavior: "REST_AT_CAP",
  // Isolated is the mexc_perpetual default, and a flat side sends it.
  ri_margin_mode: "ISOLATED",
  ri_reduce_only: false,
  ri_contracts_confirmed: false,
  ri_distribution: "LINEAR",
  ri_weight: 0,
  ri_post_only: false,
  ri_slice_amount: 0,
  ri_size_jitter_pct: 0,
  ri_price_jitter_pct: 0,
  ri_timing_jitter_pct: 0,
  // 0.6s keeps a child order inside MEXC's 4 requests per 2 seconds.
  ri_min_order_interval: 0.6,
  ri_expiry_seconds: 0,
  ri_max_slippage: 0,
  ri_random_seed: "",
  ri_show_advanced: false,
  ri_exit_arming: "ON_FULL_FILL",
  ri_tp_enabled: false,
  ri_tp_trigger: "percent",
  ri_tp_percent: 0,
  ri_tp_price: 0,
  ri_tp_execution: "SINGLE",
  ri_tp_order_type: "LIMIT",
  ri_tp_slices: 1,
  ri_tp_visible_count: 1,
  ri_tp_interval: "",
  ri_tp_price_style: "LIMIT",
  ri_tp_limit_price: 0,
  ri_tp_price_low: 0,
  ri_tp_price_high: 0,
  ri_sl_enabled: false,
  ri_sl_trigger: "percent",
  ri_sl_percent: 0,
  ri_sl_price: 0,
  ri_sl_execution: "SINGLE",
  ri_sl_slices: 1,
  ri_sl_visible_count: 1,
  ri_sl_interval: "",
  ri_sl_price_style: "LIMIT",
  ri_sl_limit_price: 0,
  ri_sl_price_low: 0,
  ri_sl_price_high: 0,
};

const STORAGE_KEY = ORDER_DEFAULTS_KEY;

const PERSISTED_FIELDS: (keyof OrderState)[] = [
  "side", "amount", "execution_strategy", "leverage",
  "chaser_distance", "chaser_refresh_threshold", "position_action",
  "ri_mode", "ri_total_amount", "ri_size_unit", "ri_iceberg", "ri_visible_count",
  "ri_levels", "ri_duration", "ri_schedule_slices", "ri_schedule_interval",
  "ri_catch_up", "ri_cap_behavior", "ri_margin_mode", "ri_reduce_only",
  "ri_distribution", "ri_weight", "ri_post_only", "ri_min_order_interval",
];

function loadSavedDefaults(): OrderState {
  const loaded = loadPersistedDefaults(STORAGE_KEY, ORDER_DEFAULTS, PERSISTED_FIELDS);
  if (loaded.ri_size_unit !== "QUOTE") loaded.ri_size_unit = "BASE";
  return loaded;
}

function saveDefaults(state: OrderState) {
  savePersistedDefaults(STORAGE_KEY, state, PERSISTED_FIELDS);
}

function clearedPrices(state: OrderState): OrderState {
  const next: OrderState = {
    ...state,
    price: 0,
    ri_price_low: 0,
    ri_price_high: 0,
    ri_limit_price: 0,
    anchored: false,
  };
  for (const key of EXIT_PRICE_FIELDS) next[key] = 0;
  return next;
}

export function orderReducer(state: OrderState, action: OrderAction): OrderState {
  switch (action.type) {
    case "SET_FIELD":
      if (action.field === "leverage") {
        // Typing updates the draft only. Apply sends it, and only after this.
        return { ...state, leverage: Number(action.value), leverageExplicit: false, leverageTouched: true };
      }
      if (action.field === "ri_margin_mode") {
        return {
          ...state,
          ri_margin_mode: action.value as OrderState["ri_margin_mode"],
          marginExplicit: true,
        };
      }
      if (action.field === "ri_size_unit") {
        return {
          ...state,
          ri_size_unit: action.value === "QUOTE" ? "QUOTE" : "BASE",
          ri_contracts_confirmed: false,
        };
      }
      return { ...state, [action.field]: action.value };
    case "ADOPT_LEVERAGE":
      if (state.leverage === action.value && !state.leverageTouched) return state;
      return { ...state, leverage: action.value, leverageExplicit: false, leverageTouched: false };
    case "QUANTIZE": {
      const q = (value: number) => quantizePrice(value, action.increment);
      const next: OrderState = {
        ...state,
        price: q(state.price),
        ri_price_low: q(state.ri_price_low),
        ri_price_high: q(state.ri_price_high),
        ri_limit_price: q(state.ri_limit_price),
      };
      for (const key of EXIT_PRICE_FIELDS) next[key] = q(state[key]);
      const same =
        next.price === state.price &&
        next.ri_price_low === state.ri_price_low &&
        next.ri_price_high === state.ri_price_high &&
        next.ri_limit_price === state.ri_limit_price &&
        EXIT_PRICE_FIELDS.every((key) => next[key] === state[key]);
      return same ? state : next;
    }
    case "SET_CONNECTOR":
    case "SET_PAIR":
      return { ...clearedPrices(state), leverageExplicit: false };
    case "ANCHOR": {
      if (state.anchored) return state;
      // Filled whatever the strategy is: a market order hides the field, but
      // switching to LIMIT afterwards should find a price already on the chart.
      const price = state.price > 0 ? state.price : action.price;
      const low = state.ri_price_low > 0 ? state.ri_price_low : action.price * 0.99;
      const high = state.ri_price_high > 0 ? state.ri_price_high : action.price * 1.01;
      const limit = state.ri_limit_price > 0 ? state.ri_limit_price : action.price;
      return {
        ...state,
        price,
        ri_price_low: low,
        ri_price_high: high,
        ri_limit_price: limit,
        anchored: true,
      };
    }
    default:
      return state;
  }
}

/** The strategies that rest an order at a price of the user's choosing. */
export function usesLimitPrice(strategy: string): boolean {
  return strategy === "LIMIT" || strategy === "LIMIT_MAKER";
}

export function isRangeIceberg(strategy: string): boolean {
  return strategy === "RANGE_ICEBERG";
}

function oneExit(
  enabled: boolean,
  trigger: ExitTrigger,
  percent: number,
  price: number,
  execution: ExitExecution,
  orderType: ExitOrderType,
  slices: number,
  visibleCount: number,
  interval: string,
  priceStyle: ExitPriceStyle,
  limitPrice: number,
  priceLow: number,
  priceHigh: number,
): RangeIcebergExitInput | null {
  if (!enabled) return null;
  return {
    trigger,
    percent,
    price,
    execution,
    orderType,
    slices,
    visibleCount,
    interval,
    priceStyle,
    limitPrice,
    priceLow,
    priceHigh,
  };
}

function quantizeExit(exit: RangeIcebergExitInput, tick: number): RangeIcebergExitInput {
  return {
    ...exit,
    price: quantizePrice(exit.price, tick),
    limitPrice: quantizePrice(exit.limitPrice, tick),
    priceLow: quantizePrice(exit.priceLow, tick),
    priceHigh: quantizePrice(exit.priceHigh, tick),
  };
}

export function rangeIcebergInput(state: OrderState): RangeIcebergInput {
  return {
    side: state.side === 1 ? "BUY" : "SELL",
    mode: state.ri_mode,
    totalAmount: state.ri_total_amount,
    sizeUnit: state.ri_size_unit,
    priceLow: state.ri_price_low,
    priceHigh: state.ri_price_high,
    limitPrice: state.ri_limit_price,
    iceberg: state.ri_iceberg,
    visibleCount: state.ri_visible_count,
    levels: state.ri_levels,
    duration: state.ri_duration,
    scheduleSlices: state.ri_schedule_slices,
    scheduleInterval: state.ri_schedule_interval,
    catchUp: state.ri_catch_up,
    capBehavior: state.ri_cap_behavior,
    leverage: state.leverage,
    marginMode: state.ri_margin_mode,
    reduceOnly: state.ri_reduce_only,
    distribution: state.ri_distribution,
    weight: state.ri_weight,
    postOnly: state.ri_post_only,
    sliceAmount: state.ri_slice_amount,
    sizeJitterPct: state.ri_size_jitter_pct,
    priceJitterPct: state.ri_price_jitter_pct,
    timingJitterPct: state.ri_timing_jitter_pct,
    minOrderInterval: state.ri_min_order_interval,
    expirySeconds: state.ri_expiry_seconds,
    maxSlippage: state.ri_max_slippage,
    randomSeed: state.ri_random_seed,
    exitArming: state.ri_exit_arming,
    takeProfit: oneExit(
      state.ri_tp_enabled,
      state.ri_tp_trigger,
      state.ri_tp_percent,
      state.ri_tp_price,
      state.ri_tp_execution,
      state.ri_tp_order_type,
      state.ri_tp_slices,
      state.ri_tp_visible_count,
      state.ri_tp_interval,
      state.ri_tp_price_style,
      state.ri_tp_limit_price,
      state.ri_tp_price_low,
      state.ri_tp_price_high,
    ),
    stopLoss: oneExit(
      state.ri_sl_enabled,
      state.ri_sl_trigger,
      state.ri_sl_percent,
      state.ri_sl_price,
      state.ri_sl_execution,
      "MARKET",
      state.ri_sl_slices,
      state.ri_sl_visible_count,
      state.ri_sl_interval,
      state.ri_sl_price_style,
      state.ri_sl_limit_price,
      state.ri_sl_price_low,
      state.ri_sl_price_high,
    ),
  };
}

// ── Validation ──

export function useOrderValidation(
  state: OrderState,
  sizeRule: SizeRule | null = null,
  baseSymbol = "",
): ExecutorValidation {
  return useMemo(() => {
    if (state.leverage < 1) {
      return { valid: false, errors: ["Leverage must be at least 1"] };
    }
    if (isRangeIceberg(state.execution_strategy)) {
      const input = rangeIcebergInput(state);
      const sent = icebergSentSize(
        input,
        sizeRule,
        conversionPrice(state),
        state.ri_contracts_confirmed,
      );
      if (sent.error) return { valid: false, errors: [sent.error] };
      input.totalAmount = sent.total;
      if (state.position_action === "CLOSE") input.reduceOnly = true;
      const message = validateRangeIceberg(input);
      return { valid: message == null, errors: message ? [message] : [] };
    }
    const errors: string[] = [];
    const sized = baseAmountMessage(state.amount, sizeRule, baseSymbol);
    if (sized) errors.push(sized);
    if (usesLimitPrice(state.execution_strategy) && state.price <= 0) {
      errors.push("Price required for limit orders");
    }
    if (state.execution_strategy === "LIMIT_CHASER") {
      if (state.chaser_distance <= 0) errors.push("Chaser distance required");
      if (state.chaser_refresh_threshold <= 0) errors.push("Chaser refresh threshold required");
    }
    return { valid: errors.length === 0, errors };
  }, [state, sizeRule, baseSymbol]);
}

function conversionPrice(state: OrderState): number {
  if (state.ri_mode === "UP_TO") return state.ri_limit_price;
  return Math.max(state.ri_price_low, state.ri_price_high);
}

function baseAmountMessage(
  amount: number,
  rule: SizeRule | null,
  baseSymbol: string,
): string | null {
  if (!(amount > 0)) return "Amount required";
  if (!rule || !(rule.minOrderSize > 0)) return null;
  const snapped = legalBaseAmount(amount, rule);
  if (snapped < rule.minOrderSize) {
    return `Minimum order size is ${rule.minOrderSize} ${baseSymbol}`;
  }
  return null;
}

// ── Hook ──

export function useOrderConfig(sizeRule: SizeRule | null = null, baseSymbol = "") {
  const [state, dispatch] = useReducer(orderReducer, undefined, loadSavedDefaults);
  const priceIncrement = sizeRule?.priceIncrement ?? 0;
  const priceStamp = [
    state.price,
    state.ri_price_low,
    state.ri_price_high,
    state.ri_limit_price,
    ...EXIT_PRICE_FIELDS.map((key) => state[key]),
  ].join(",");
  useEffect(() => {
    if (!(priceIncrement > 0)) return;
    dispatch({ type: "QUANTIZE", increment: priceIncrement });
  }, [priceIncrement, priceStamp]);
  const validation = useOrderValidation(state, sizeRule, baseSymbol);

  const chartProps: ChartPriceMapping = useMemo(() => {
    if (isRangeIceberg(state.execution_strategy)) {
      const upTo = state.ri_mode === "UP_TO";
      const field = state.activePickField;
      const pick: PickSlot | null =
        field === "ri_price_high"
          ? "end"
          : field === "ri_price_low" || field === "ri_limit_price"
            ? "start"
            : field && EXIT_PICK_FIELDS.has(field)
              ? field
              : null;
      const reference = exitReference({
        mode: state.ri_mode,
        limitPrice: state.ri_limit_price,
        priceLow: state.ri_price_low,
        priceHigh: state.ri_price_high,
      });
      const side = state.side === 1 ? "BUY" : "SELL";
      const extraLines: ExtraLine[] = [];
      const addExitLine = (
        enabled: boolean,
        trigger: ExitTrigger,
        percent: number,
        price: number,
        kind: "take_profit" | "stop_loss",
        label: string,
        color: string,
        slot: string,
      ) => {
        if (!enabled || !reference) return;
        const triggerPrice = exitTriggerPrice(side, kind, { trigger, percent, price }, reference.price);
        if (triggerPrice == null || !(triggerPrice > 0)) return;
        extraLines.push({
          price: triggerPrice,
          label,
          color,
          lineStyle: "dashed",
          slot: trigger === "price" ? slot : undefined,
        });
      };
      addExitLine(
        state.ri_tp_enabled,
        state.ri_tp_trigger,
        state.ri_tp_percent,
        state.ri_tp_price,
        "take_profit",
        "Take profit",
        "#22c55e",
        "ri_tp_price",
      );
      addExitLine(
        state.ri_sl_enabled,
        state.ri_sl_trigger,
        state.ri_sl_percent,
        state.ri_sl_price,
        "stop_loss",
        "Stop loss",
        "#ef4444",
        "ri_sl_price",
      );
      const lineLabels: NonNullable<ChartPriceMapping["lineLabels"]> = upTo
        ? { start: "Limit" }
        : { start: "Low", end: "High" };
      lineLabels.ri_tp_price = "Take profit";
      lineLabels.ri_tp_limit_price = "TP limit";
      lineLabels.ri_tp_price_low = "TP low";
      lineLabels.ri_tp_price_high = "TP high";
      lineLabels.ri_sl_price = "Stop loss";
      lineLabels.ri_sl_limit_price = "SL limit";
      lineLabels.ri_sl_price_low = "SL low";
      lineLabels.ri_sl_price_high = "SL high";
      return {
        startPrice: upTo ? state.ri_limit_price : state.ri_price_low,
        endPrice: upTo ? 0 : state.ri_price_high,
        limitPrice: 0,
        side: state.side,
        minSpread: 0,
        activePickField: pick,
        extraLines: extraLines.length > 0 ? extraLines : undefined,
        lineLabels,
      };
    }
    return {
      // Only a resting order has a price to draw. A market order has none, and a
      // chaser's price is the book's rather than the form's — drawing the stale
      // number either one leaves behind would put a line on the chart that the
      // order will not be placed at.
      startPrice: usesLimitPrice(state.execution_strategy) ? state.price : 0,
      endPrice: 0,
      limitPrice: 0,
      side: state.side,
      minSpread: 0,
      activePickField: state.activePickField === "price" ? "start" : null,
      // The `start` slot carries the order price here.
      lineLabels: { start: "Price" },
    };
  }, [
    state.price,
    state.side,
    state.execution_strategy,
    state.activePickField,
    state.ri_mode,
    state.ri_price_low,
    state.ri_price_high,
    state.ri_limit_price,
    state.ri_tp_enabled,
    state.ri_tp_trigger,
    state.ri_tp_percent,
    state.ri_tp_price,
    state.ri_sl_enabled,
    state.ri_sl_trigger,
    state.ri_sl_percent,
    state.ri_sl_price,
  ]);

  const buildPayload = (
    connector: string,
    pair: string,
    isSpot: boolean,
    asRange = false,
    maxBase = 0,
    book?: { positionsKnown: boolean; sideHasPosition: boolean | null },
  ) => {
    const tick = sizeRule?.priceIncrement ?? 0;
    if (asRange || isRangeIceberg(state.execution_strategy)) {
      const input = rangeIcebergInput(state);
      input.priceLow = quantizePrice(input.priceLow, tick);
      input.priceHigh = quantizePrice(input.priceHigh, tick);
      input.limitPrice = quantizePrice(input.limitPrice, tick);
      if (input.takeProfit) input.takeProfit = quantizeExit(input.takeProfit, tick);
      if (input.stopLoss) input.stopLoss = quantizeExit(input.stopLoss, tick);
      if (state.position_action === "CLOSE") input.reduceOnly = true;
      const sent = icebergSentSize(
        input,
        sizeRule,
        conversionPrice(state),
        state.ri_contracts_confirmed,
        maxBase,
      );
      if (!sent.error) {
        input.totalAmount = sent.total;
        input.sliceAmount = sent.perSlice;
        if (sent.sizeUnit) input.sizeUnit = sent.sizeUnit;
      }
      const margin = marginForOpen({
        isSpot,
        opening: state.position_action !== "CLOSE",
        explicit: state.marginExplicit,
        displayed: state.ri_margin_mode,
        positionsKnown: book?.positionsKnown ?? false,
        sideHasPosition: book?.sideHasPosition ?? null,
      });
      if ("block" in margin) throw new Error(margin.block);
      const config = rangeIcebergConfig(input, connector, pair, margin.send);
      if (margin.send) {
        config.margin_mode = margin.mode;
        config.margin_explicit = true;
      }
      return {
        executor_type: "range_iceberg_executor" as const,
        config,
      };
    }

    let amount = legalBaseAmount(state.amount, sizeRule);
    if (maxBase > 0 && amount > maxBase) amount = legalBaseAmount(maxBase, sizeRule);
    const config: Record<string, unknown> = {
      connector_name: connector,
      trading_pair: pair,
      side: state.side,
      amount,
      leverage: isSpot ? 1 : state.leverage,
      execution_strategy: state.execution_strategy,
    };

    if (usesLimitPrice(state.execution_strategy)) {
      config.price = quantizePrice(state.price, tick);
    }
    if (state.execution_strategy === "LIMIT_CHASER") {
      config.chaser_config = {
        distance: state.chaser_distance,
        refresh_threshold: state.chaser_refresh_threshold,
      };
    }
    if (state.position_action !== "OPEN") {
      config.position_action = state.position_action;
    }
    // A flat side sends the displayed mode, Isolated unless the user changed it.
    // An open position is omitted until the user edits it.
    const margin = marginForOpen({
      isSpot,
      opening: state.position_action !== "CLOSE",
      explicit: state.marginExplicit,
      displayed: state.ri_margin_mode,
      positionsKnown: book?.positionsKnown ?? false,
      sideHasPosition: book?.sideHasPosition ?? null,
    });
    if ("block" in margin) throw new Error(margin.block);
    if (margin.send) {
      config.margin_mode = margin.mode;
      config.margin_explicit = true;
    }

    return { executor_type: "order_executor" as const, config };
  };

  const save = () => saveDefaults(state);

  const handleChartPriceSet = (field: PickSlot, price: number) => {
    if (isRangeIceberg(state.execution_strategy)) {
      if (field === "start" || field === "end") {
        const key =
          field === "end"
            ? "ri_price_high"
            : state.ri_mode === "UP_TO"
              ? "ri_limit_price"
              : "ri_price_low";
        dispatch({ type: "SET_FIELD", field: key, value: price });
      } else if (EXIT_PICK_FIELDS.has(field)) {
        dispatch({ type: "SET_FIELD", field, value: price });
      }
    } else if (field === "start") {
      dispatch({ type: "SET_FIELD", field: "price", value: price });
    }
    dispatch({ type: "SET_FIELD", field: "activePickField", value: null });
  };

  return { state, dispatch, validation, chartProps, buildPayload, save, handleChartPriceSet };
}
