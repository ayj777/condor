import { useState } from "react";

import { approximateQuoteLabel, formatTokenAmount, orderStep, roundDownNote, sizeUnitChoices, type SizeRule } from "@/lib/order-size";
import {
  exitPreviewText,
  exitReference,
  exitTriggerPrice,
  formatInterval,
  icebergSentSize,
  jitterNote,
  oneAtATimeText,
  rangeIcebergPreview,
  scheduleNote,
  scheduleStartLine,
  unevenSliceText,
  stopProtectionText,
  upToTakeProfitNote,
  type ExitKind,
  type RangeIcebergExitInput,
} from "@/lib/range-iceberg";
import { rangeIcebergInput, type OrderAction, type OrderState } from "./order-config";
import { NumberField, PriceField, SectionHeader, SelectField } from "./fields";

/**
 * The range iceberg executor's fields, in the order the config declares them.
 *
 * Amounts are in the pair's base or quote token. A size that is not a whole
 * number of contracts is rounded down before it is sent.
 */

const MODE_OPTIONS = [
  { value: "RANGE", label: "Range" },
  { value: "UP_TO", label: "Up to" },
];
const CAP_OPTIONS = [
  { value: "REST_AT_CAP", label: "Rest at cap" },
  { value: "WAIT", label: "Wait" },
];
const DISTRIBUTION_OPTIONS = [
  { value: "LINEAR", label: "Linear" },
  { value: "GEOMETRIC", label: "Geometric" },
  { value: "WEIGHTED", label: "Weighted" },
];
const START_OPTIONS = [
  { value: "SUBMIT", label: "Submit" },
  { value: "FIRST_FILL", label: "First fill" },
];
const ARM_OPTIONS = [
  { value: "ON_FULL_FILL", label: "After full fill" },
  { value: "ON_ANY_FILL", label: "On any fill" },
];
const TRIGGER_OPTIONS = [
  { value: "percent", label: "Percent" },
  { value: "price", label: "Price" },
];
const EXECUTION_OPTIONS = [
  { value: "SINGLE", label: "Single order" },
  { value: "ICEBERG", label: "Iceberg" },
];
const EXIT_ORDER_OPTIONS = [
  { value: "LIMIT", label: "Limit" },
  { value: "MARKET", label: "Market" },
];
const EXIT_PRICE_OPTIONS = [
  { value: "LIMIT", label: "Up to" },
  { value: "RANGE", label: "Range" },
];

type ExitPrefix = "ri_tp" | "ri_sl";

function exitDraft(state: OrderState, prefix: ExitPrefix): RangeIcebergExitInput {
  if (prefix === "ri_tp") {
    return {
      trigger: state.ri_tp_trigger,
      percent: state.ri_tp_percent,
      price: state.ri_tp_price,
      execution: state.ri_tp_execution,
      orderType: state.ri_tp_order_type,
      slices: state.ri_tp_slices,
      visibleCount: state.ri_tp_visible_count,
      interval: state.ri_tp_interval,
      priceStyle: state.ri_tp_price_style,
      limitPrice: state.ri_tp_limit_price,
      priceLow: state.ri_tp_price_low,
      priceHigh: state.ri_tp_price_high,
    };
  }
  return {
    trigger: state.ri_sl_trigger,
    percent: state.ri_sl_percent,
    price: state.ri_sl_price,
    execution: state.ri_sl_execution,
    orderType: "MARKET",
    slices: state.ri_sl_slices,
    visibleCount: state.ri_sl_visible_count,
    interval: state.ri_sl_interval,
    priceStyle: state.ri_sl_price_style,
    limitPrice: state.ri_sl_limit_price,
    priceLow: state.ri_sl_price_low,
    priceHigh: state.ri_sl_price_high,
  };
}

export function ExitEditor({
  title,
  kind,
  prefix,
  stop,
  state,
  dispatch,
  reference,
  bound = null,
}: {
  title: string;
  kind: ExitKind;
  prefix: ExitPrefix;
  stop: boolean;
  state: OrderState;
  dispatch: React.Dispatch<OrderAction>;
  reference: { price: number; label: string } | null;
  /** A range wall the absolute trigger must stay on the safe side of. */
  bound?: { minExclusive?: number; maxExclusive?: number } | null;
}) {
  const enabled = prefix === "ri_tp" ? state.ri_tp_enabled : state.ri_sl_enabled;
  const draft = exitDraft(state, prefix);
  const name = (field: string) => `${prefix}_${field}`;
  const long = state.side === 1;
  const priceValid = (() => {
    if (!(draft.price > 0)) return false;
    if (bound?.maxExclusive != null && bound.maxExclusive > 0 && !(draft.price < bound.maxExclusive)) return false;
    if (bound?.minExclusive != null && bound.minExclusive > 0 && !(draft.price > bound.minExclusive)) return false;
    if (!reference) return true;
    const above = kind === "take_profit" ? long : !long;
    return above ? draft.price > reference.price : draft.price < reference.price;
  })();
  return (
    <div className="space-y-2.5 rounded border border-[var(--color-border)] p-2">
      <Toggle label={title} checked={enabled} onChange={(v) => dispatch({ type: "SET_FIELD", field: name("enabled"), value: v })} />
      {enabled && (
        <>
          <SelectField
            label={`${title} trigger`}
            value={draft.trigger}
            field={name("trigger")}
            dispatch={dispatch}
            options={TRIGGER_OPTIONS}
          />
          {draft.trigger === "percent" ? (
            <NumberField
              label="Percent"
              value={draft.percent}
              field={name("percent")}
              dispatch={dispatch}
              step={0.0001}
              min={0}
              isPercent
              suffix="%"
            />
          ) : (
            <PriceField
              label="Trigger price"
              value={draft.price}
              field={name("price")}
              activePickField={state.activePickField}
              dispatch={dispatch}
              valid={priceValid}
            />
          )}
          <p className="text-[10px] text-[var(--color-text-muted)]">
            {exitPreviewText(kind, draft, reference)}
          </p>
          <SelectField
            label={`${title} close`}
            value={draft.execution}
            field={name("execution")}
            dispatch={dispatch}
            options={EXECUTION_OPTIONS}
          />
          {draft.execution === "SINGLE" && !stop && (
            <SelectField
              label="Order type"
              value={draft.orderType}
              field={name("order_type")}
              dispatch={dispatch}
              options={EXIT_ORDER_OPTIONS}
            />
          )}
          {draft.execution === "SINGLE" && stop && (
            <p className="text-[10px] text-[var(--color-text-muted)]">
              A single stop loss sends a market order.
            </p>
          )}
          {draft.execution === "ICEBERG" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Slices" value={draft.slices} field={name("slices")} dispatch={dispatch} step={1} min={1} />
                <NumberField label="Visible count" value={draft.visibleCount} field={name("visible_count")} dispatch={dispatch} step={1} min={1} />
              </div>
              <TextField
                label="Interval"
                value={draft.interval}
                placeholder="30s, empty sends all at once"
                onChange={(v) => dispatch({ type: "SET_FIELD", field: name("interval"), value: v })}
              />
              <SelectField
                label={`${title} prices`}
                value={draft.priceStyle}
                field={name("price_style")}
                dispatch={dispatch}
                options={EXIT_PRICE_OPTIONS}
              />
              {draft.priceStyle === "LIMIT" ? (
                <PriceField
                  label="Limit price"
                  value={draft.limitPrice}
                  field={name("limit_price")}
                  activePickField={state.activePickField}
                  dispatch={dispatch}
                  valid={draft.limitPrice > 0}
                />
              ) : (
                <>
                  <PriceField
                    label="Price low"
                    value={draft.priceLow}
                    field={name("price_low")}
                    activePickField={state.activePickField}
                    dispatch={dispatch}
                    valid={draft.priceLow > 0 && (draft.priceHigh <= 0 || draft.priceLow <= draft.priceHigh)}
                  />
                  <PriceField
                    label="Price high"
                    value={draft.priceHigh}
                    field={name("price_high")}
                    activePickField={state.activePickField}
                    dispatch={dispatch}
                    valid={draft.priceHigh > 0 && draft.priceHigh >= draft.priceLow}
                  />
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 text-xs text-[var(--color-text)]">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--color-primary)]"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="min-w-0">
      <label className="mb-1 block truncate text-xs text-[var(--color-text-muted)]">{label}</label>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/40 focus:border-[var(--color-primary)] focus:outline-none"
      />
    </div>
  );
}

export function rangeBound(
  state: OrderState,
  kind: ExitKind,
): { minExclusive?: number; maxExclusive?: number } | null {
  if (state.ri_mode !== "RANGE") return null;
  const long = state.side === 1;
  if (kind === "stop_loss") {
    if (long && state.ri_price_low > 0) return { maxExclusive: state.ri_price_low };
    if (!long && state.ri_price_high > 0) return { minExclusive: state.ri_price_high };
    return null;
  }
  if (long && state.ri_price_high > 0) return { minExclusive: state.ri_price_high };
  if (!long && state.ri_price_low > 0) return { maxExclusive: state.ri_price_low };
  return null;
}

export function RangeIcebergFields({
  state,
  dispatch,
  connector,
  sizeRule,
  baseSymbol,
  quoteSymbol,
  maxBase = 0,
  hedge = false,
  stopWarning = "",
}: {
  state: OrderState;
  dispatch: React.Dispatch<OrderAction>;
  connector: string;
  sizeRule: SizeRule | null;
  baseSymbol: string;
  quoteSymbol: string;
  maxBase?: number;
  /** Hedge open and close are the only reduce control. The toggle is hidden. */
  hedge?: boolean;
  /** Another open iceberg on this pair and side already uses this stop price. */
  stopWarning?: string;
}) {
  const [advanced, setAdvanced] = useState(state.ri_show_advanced);
  const set = (field: string, value: unknown) =>
    dispatch({ type: "SET_FIELD", field, value });
  const input = rangeIcebergInput(state);
  const preview = rangeIcebergPreview(input);
  const reference = exitReference(input);
  const limitPrice = state.ri_mode === "UP_TO" ? state.ri_limit_price : 0;
  const sent = icebergSentSize(input, sizeRule, limitPrice, state.ri_contracts_confirmed, maxBase);
  const unitSymbol = state.ri_size_unit === "QUOTE" ? quoteSymbol : baseSymbol;
  const shrunk = !sent.error && sent.total > 0 && sent.total + 1e-9 < state.ri_total_amount
    ? roundDownNote(state.ri_total_amount, sent.total, unitSymbol)
    : null;
  const baseText = !sent.error && sent.baseTotal > 0
    ? [formatTokenAmount(sent.baseTotal), baseSymbol].filter(Boolean).join(" ")
    : "";
  const totalLine = sent.error
    ? [formatTokenAmount(preview?.total ?? 0), unitSymbol].filter(Boolean).join(" ")
    : state.ri_size_unit === "QUOTE"
      ? `${[formatTokenAmount(sent.total), quoteSymbol].filter(Boolean).join(" ")}${baseText ? `, about ${baseText}` : ""}`
      : sent.quoteTotal != null && sent.baseTotal > 0 && quoteSymbol
        ? `${[formatTokenAmount(sent.total), baseSymbol].filter(Boolean).join(" ")} (${approximateQuoteLabel(sent.baseTotal, sent.quoteTotal / sent.baseTotal, quoteSymbol)})`
        : [formatTokenAmount(sent.total), unitSymbol].filter(Boolean).join(" ");
  const scheduleText = scheduleNote({
    duration: state.ri_duration,
    interval: state.ri_schedule_interval,
    total: sent.error ? state.ri_total_amount : sent.total,
    sliceAmount: state.ri_slice_amount,
    levels: state.ri_levels,
    unit: state.ri_size_unit,
    baseSymbol,
    quoteSymbol,
    price: state.ri_mode === "UP_TO" ? (state.ri_limit_price > 0 ? state.ri_limit_price : null) : null,
    baseTotal: !sent.error && state.ri_size_unit === "QUOTE" ? sent.baseTotal : null,
    expiry: state.ri_expiry,
  });
  const sizedTotal = sent.error ? state.ri_total_amount : sent.total;
  const uneven = state.ri_duration.trim()
    ? null
    : unevenSliceText(sizedTotal, state.ri_slice_amount, unitSymbol);
  const childLine = preview
    ? [formatTokenAmount(preview.perSlice), unitSymbol].filter(Boolean).join(" ")
    : "";
  const quoteUpTo = state.ri_mode === "UP_TO" && state.ri_size_unit === "QUOTE";
  const childText = uneven && quoteUpTo
    ? `Each slice buys at the limit or better. ${uneven}.`
    : `${uneven ?? `Child size ${childLine}`}${
        quoteUpTo ? " at the limit. A better price buys more base." : ""
      }`;
  const pacing = oneAtATimeText(state.ri_visible_count);
  const jitter = jitterNote(input);
  const stopTrigger = state.ri_sl_enabled
    ? exitTriggerPrice(
      state.side === 1 ? "BUY" : "SELL",
      "stop_loss",
      exitDraft(state, "ri_sl"),
      reference?.price ?? 0,
    )
    : null;
  const takeNote = upToTakeProfitNote(input);
  const showCap = state.ri_mode === "UP_TO"
    || (state.ri_tp_enabled && state.ri_tp_execution === "ICEBERG");

  return (
    <div className="space-y-2.5">
      <SectionHeader>Iceberg</SectionHeader>
      <SelectField
        label="Mode"
        value={state.ri_mode}
        field="ri_mode"
        dispatch={dispatch}
        options={MODE_OPTIONS}
      />
      <NumberField
        label={unitSymbol ? `Total amount (${unitSymbol})` : "Total amount"}
        value={state.ri_total_amount}
        field="ri_total_amount"
        dispatch={dispatch}
        step={sizeRule && state.ri_size_unit === "BASE" && sizeRule.increment > 0 ? sizeRule.increment : 0.001}
        min={0}
      />
      {sizeRule && state.ri_size_unit === "BASE" && sizeRule.minOrderSize > 0 && (
        <p className="text-[10px] text-[var(--color-text-muted)]">
          Step {formatTokenAmount(orderStep(sizeRule) || sizeRule.minOrderSize)}{baseSymbol ? ` ${baseSymbol}` : ""}. Minimum {formatTokenAmount(sizeRule.minOrderSize)}.
        </p>
      )}
      {shrunk && (
        <p className="text-[10px] text-[var(--color-text-muted)]">{shrunk}</p>
      )}
      <SelectField
        label="Size unit"
        value={state.ri_size_unit}
        field="ri_size_unit"
        dispatch={dispatch}
        options={sizeUnitChoices(baseSymbol, quoteSymbol)}
      />
      {connector === "mexc_perpetual" && (
        <p className="text-[10px] text-[var(--color-text-muted)]">
          {sizeRule?.contractSize
            ? `One contract is ${formatTokenAmount(sizeRule.contractSize)} ${baseSymbol}. A size that is not a whole contract is rounded down. `
            : ""}
          Child orders wait at least {state.ri_min_order_interval}s, inside the 4 requests per 2 seconds limit.
        </p>
      )}
      {state.ri_mode === "RANGE" ? (
        <>
          <PriceField
            label="Price low"
            value={state.ri_price_low}
            field="ri_price_low"
            activePickField={state.activePickField}
            dispatch={dispatch}
            valid={state.ri_price_low > 0}
          />
          <PriceField
            label="Price high"
            value={state.ri_price_high}
            field="ri_price_high"
            activePickField={state.activePickField}
            dispatch={dispatch}
            valid={state.ri_price_high > 0 && state.ri_price_high >= state.ri_price_low}
          />
        </>
      ) : (
        <PriceField
          label="Limit price"
          value={state.ri_limit_price}
          field="ri_limit_price"
          activePickField={state.activePickField}
          dispatch={dispatch}
          valid={state.ri_limit_price > 0}
        />
      )}
      <p className="text-[10px] text-[var(--color-text-muted)]">{pacing}</p>
      <NumberField
        label={state.ri_mode === "RANGE" ? "Price rungs" : "Levels"}
        value={state.ri_levels}
        field="ri_levels"
        dispatch={dispatch}
        step={1}
        min={1}
      />
      <div className="grid grid-cols-2 gap-2">
        <TextField
          label="Duration"
          value={state.ri_duration}
          placeholder="24h, 30m, or seconds"
          onChange={(v) => set("ri_duration", v)}
        />
        <TextField
          label="Expiry, from submit"
          value={state.ri_expiry}
          placeholder="30m, 24h, or seconds"
          onChange={(v) => set("ri_expiry", v)}
        />
      </div>
      <TextField
        label="Schedule interval"
        value={state.ri_schedule_interval}
        placeholder="30s"
        onChange={(v) => set("ri_schedule_interval", v)}
      />
      {state.ri_duration.trim() && (
        <>
          <SelectField
            label="Schedule start"
            value={state.ri_schedule_start}
            field="ri_schedule_start"
            dispatch={dispatch}
            options={START_OPTIONS}
          />
          <p className="text-[10px] text-[var(--color-text-muted)]">{scheduleStartLine(state.ri_schedule_start)}</p>
        </>
      )}
      {scheduleText && (
        <p className="text-[10px] text-[var(--color-text-muted)]">{scheduleText}</p>
      )}
      {showCap && (
        <SelectField
          label={state.ri_mode === "RANGE" ? "Take profit cap" : "Cap behavior"}
          value={state.ri_cap_behavior}
          field="ri_cap_behavior"
          dispatch={dispatch}
          options={CAP_OPTIONS}
        />
      )}
      {hedge ? (
        <p className="text-[10px] text-[var(--color-text-muted)]">Open adds a position. Close reduces it.</p>
      ) : (
        <Toggle label="Reduce only" checked={state.ri_reduce_only} onChange={(v) => set("ri_reduce_only", v)} />
      )}
      <SectionHeader>Exits</SectionHeader>
      <SelectField
        label="Arm exits"
        value={state.ri_exit_arming}
        field="ri_exit_arming"
        dispatch={dispatch}
        options={ARM_OPTIONS}
      />
      <p className="text-[10px] text-[var(--color-text-muted)]">
        After full fill waits for the whole entry. On any fill, a limit take profit rests and grows with fills. A market or iceberg take profit cancels the remaining entry. Exit orders are not post only.
      </p>
      <ExitEditor
        title="Take profit"
        kind="take_profit"
        prefix="ri_tp"
        stop={false}
        state={state}
        dispatch={dispatch}
        reference={reference}
        bound={rangeBound(state, "take_profit")}
      />
      {takeNote && (
        <p className="text-[10px] text-[var(--color-text-muted)]">{takeNote}</p>
      )}
      <ExitEditor
        title="Stop loss"
        kind="stop_loss"
        prefix="ri_sl"
        stop
        state={state}
        dispatch={dispatch}
        reference={reference}
        bound={rangeBound(state, "stop_loss")}
      />
      {state.ri_sl_enabled && (
        <p className="text-[10px] text-[var(--color-text-muted)]">
          {stopProtectionText(state.side === 1 ? "BUY" : "SELL", stopTrigger)}
        </p>
      )}
      {stopWarning && (
        <p className="text-[10px] text-[var(--color-red)]">{stopWarning}</p>
      )}
      {preview && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">
          <p className="font-medium text-[var(--color-text)]">Preview</p>
          <p>Total {totalLine}</p>
          {state.ri_mode === "RANGE" ? (
            <p>{sent.rungs ?? preview.sliceCount} price rungs</p>
          ) : (
            <p>{childText}</p>
          )}
          <p>Interval {formatInterval(preview.intervalSeconds)}</p>
          <p>{pacing}</p>
          {jitter && <p>{jitter}</p>}
          {sent.error && <p className="text-[var(--color-red)]">{sent.error}</p>}
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          setAdvanced((v) => !v);
          set("ri_show_advanced", !advanced);
        }}
        className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        {advanced ? "Hide advanced" : "Advanced"}
      </button>
      {advanced && (
        <div className="space-y-2.5">
          <NumberField
            label="orders shown at once"
            value={state.ri_visible_count}
            field="ri_visible_count"
            dispatch={dispatch}
            step={1}
            min={1}
          />
          {state.ri_mode === "RANGE" && (
            <>
              <SelectField label="Distribution" value={state.ri_distribution} field="ri_distribution" dispatch={dispatch} options={DISTRIBUTION_OPTIONS} />
              <NumberField label="Weight" value={state.ri_weight} field="ri_weight" dispatch={dispatch} step={0.1} />
              <p className="text-[10px] text-[var(--color-text-muted)]">
                Positive puts more size at the high end. Negative puts more at the low end. Weighted uses the same prices as Linear.
              </p>
            </>
          )}
          <Toggle label="Post only" checked={state.ri_post_only} onChange={(v) => set("ri_post_only", v)} />
          <p className="text-[10px] text-[var(--color-text-muted)]">Exit orders are not post only.</p>
          <NumberField label="Slice amount" value={state.ri_slice_amount} field="ri_slice_amount" dispatch={dispatch} step={0.001} min={0} />
          <NumberField label="Size jitter" value={state.ri_size_jitter_pct} field="ri_size_jitter_pct" dispatch={dispatch} step={0.0001} min={0} isPercent suffix="%" />
          <NumberField label="Price jitter" value={state.ri_price_jitter_pct} field="ri_price_jitter_pct" dispatch={dispatch} step={0.0001} min={0} isPercent suffix="%" />
          <NumberField label="Timing jitter" value={state.ri_timing_jitter_pct} field="ri_timing_jitter_pct" dispatch={dispatch} step={0.0001} min={0} isPercent suffix="%" />
          <NumberField label="Min order interval (s)" value={state.ri_min_order_interval} field="ri_min_order_interval" dispatch={dispatch} step={0.1} min={0} />
          {state.ri_min_order_interval === 0 && (
            <p className="text-[10px] text-[var(--color-text-muted)]">0 sends orders back to back.</p>
          )}
          {state.ri_mode === "RANGE" && (
            <NumberField label="Max slippage" value={state.ri_max_slippage} field="ri_max_slippage" dispatch={dispatch} step={0.001} min={0} />
          )}
          <TextField label="Random seed" value={state.ri_random_seed} placeholder="optional" onChange={(v) => set("ri_random_seed", v)} />
          <p className="text-[10px] text-[var(--color-text-muted)]">Repeats the jitter sequence.</p>
        </div>
      )}
    </div>
  );
}
