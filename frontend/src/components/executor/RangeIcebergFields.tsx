import { useState } from "react";

import { approximateQuoteLabel, formatTokenAmount, orderStep, roundDownNote, sizeUnitChoices, type SizeRule } from "@/lib/order-size";
import {
  exitPreviewText,
  exitReference,
  formatInterval,
  icebergSentSize,
  rangeIcebergPreview,
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
const CATCH_UP_OPTIONS = [
  { value: "CARRY", label: "Carry" },
  { value: "SKIP", label: "Skip" },
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
}: {
  title: string;
  kind: ExitKind;
  prefix: ExitPrefix;
  stop: boolean;
  state: OrderState;
  dispatch: React.Dispatch<OrderAction>;
  reference: { price: number; label: string } | null;
}) {
  const enabled = prefix === "ri_tp" ? state.ri_tp_enabled : state.ri_sl_enabled;
  const draft = exitDraft(state, prefix);
  const name = (field: string) => `${prefix}_${field}`;
  const long = state.side === 1;
  const priceValid = (() => {
    if (!(draft.price > 0) || !reference) return draft.price > 0;
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

export function RangeIcebergFields({
  state,
  dispatch,
  connector,
  sizeRule,
  baseSymbol,
  quoteSymbol,
  maxBase = 0,
}: {
  state: OrderState;
  dispatch: React.Dispatch<OrderAction>;
  connector: string;
  sizeRule: SizeRule | null;
  baseSymbol: string;
  quoteSymbol: string;
  maxBase?: number;
}) {
  const [advanced, setAdvanced] = useState(state.ri_show_advanced);
  const set = (field: string, value: unknown) =>
    dispatch({ type: "SET_FIELD", field, value });
  const input = rangeIcebergInput(state);
  const preview = rangeIcebergPreview(input);
  const reference = exitReference(input);
  const price = state.ri_mode === "UP_TO"
    ? state.ri_limit_price
    : Math.max(state.ri_price_low, state.ri_price_high);
  const sent = icebergSentSize(input, sizeRule, price, state.ri_contracts_confirmed, maxBase);
  const unitSymbol = state.ri_size_unit === "QUOTE" ? quoteSymbol : baseSymbol;
  const requestedBase = state.ri_size_unit === "QUOTE"
    ? (price > 0 ? state.ri_total_amount / price : 0)
    : state.ri_total_amount;
  const rounded = sent.error ? null : roundDownNote(requestedBase, sent.total, baseSymbol);
  const sentBaseText = [formatTokenAmount(sent.total), baseSymbol].filter(Boolean).join(" ");
  const sentQuote = !sent.error && price > 0 ? approximateQuoteLabel(sent.total, price, quoteSymbol) : "";
  const totalLine = sent.error
    ? [formatTokenAmount(preview?.total ?? 0), unitSymbol].filter(Boolean).join(" ")
    : state.ri_size_unit === "QUOTE"
      ? `${[formatTokenAmount(state.ri_total_amount), quoteSymbol].filter(Boolean).join(" ")}, about ${sentBaseText}${sentQuote && Math.abs((sent.total * price) - state.ri_total_amount) > Math.max(1e-8, state.ri_total_amount * 1e-6) ? ` (${sentQuote})` : ""}`
      : sentQuote
        ? `${sentBaseText} (${sentQuote})`
        : sentBaseText;
  const sliceLine = sent.error
    ? [formatTokenAmount(preview?.perSlice ?? 0), unitSymbol].filter(Boolean).join(" ")
    : sentQuote
      ? `${[formatTokenAmount(sent.perSlice), baseSymbol].filter(Boolean).join(" ")} (${approximateQuoteLabel(sent.perSlice, price, quoteSymbol)})`
      : [formatTokenAmount(sent.perSlice), baseSymbol].filter(Boolean).join(" ");

  return (
    <div className="space-y-2.5">
      <SectionHeader>Range iceberg</SectionHeader>
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
      {rounded && (
        <p className="text-[10px] text-[var(--color-text-muted)]">{rounded}</p>
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
      <Toggle label="Iceberg" checked={state.ri_iceberg} onChange={(v) => set("ri_iceberg", v)} />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Visible count" value={state.ri_visible_count} field="ri_visible_count" dispatch={dispatch} step={1} min={1} />
        <NumberField label="Levels" value={state.ri_levels} field="ri_levels" dispatch={dispatch} step={1} min={1} />
      </div>
      <TextField
        label="Duration"
        value={state.ri_duration}
        placeholder="24h, 30m, or seconds"
        onChange={(v) => set("ri_duration", v)}
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Schedule slices" value={state.ri_schedule_slices} field="ri_schedule_slices" dispatch={dispatch} step={1} min={0} />
        <TextField
          label="Schedule interval"
          value={state.ri_schedule_interval}
          placeholder="30s"
          onChange={(v) => set("ri_schedule_interval", v)}
        />
      </div>
      <SelectField label="Catch up" value={state.ri_catch_up} field="ri_catch_up" dispatch={dispatch} options={CATCH_UP_OPTIONS} />
      <SelectField label="Cap behavior" value={state.ri_cap_behavior} field="ri_cap_behavior" dispatch={dispatch} options={CAP_OPTIONS} />
      <Toggle label="Reduce only" checked={state.ri_reduce_only} onChange={(v) => set("ri_reduce_only", v)} />
      <SectionHeader>Exits</SectionHeader>
      <SelectField
        label="Arm exits"
        value={state.ri_exit_arming}
        field="ri_exit_arming"
        dispatch={dispatch}
        options={ARM_OPTIONS}
      />
      <p className="text-[10px] text-[var(--color-text-muted)]">
        After full fill waits for the whole entry. On any fill, a limit take profit rests and grows with fills. A market or iceberg take profit waits for its trigger price.
      </p>
      <ExitEditor
        title="Take profit"
        kind="take_profit"
        prefix="ri_tp"
        stop={false}
        state={state}
        dispatch={dispatch}
        reference={reference}
      />
      <ExitEditor
        title="Stop loss"
        kind="stop_loss"
        prefix="ri_sl"
        stop
        state={state}
        dispatch={dispatch}
        reference={reference}
      />
      {preview && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">
          <p className="font-medium text-[var(--color-text)]">Preview</p>
          <p>Total {totalLine}</p>
          <p>Per slice {sliceLine} across {preview.sliceCount}</p>
          <p>Interval {formatInterval(preview.intervalSeconds)}</p>
          <p>Max price {preview.maxPrice ?? "not set"}</p>
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
          <SelectField label="Distribution" value={state.ri_distribution} field="ri_distribution" dispatch={dispatch} options={DISTRIBUTION_OPTIONS} />
          <NumberField label="Weight" value={state.ri_weight} field="ri_weight" dispatch={dispatch} step={0.1} />
          <Toggle label="Post only" checked={state.ri_post_only} onChange={(v) => set("ri_post_only", v)} />
          <NumberField label="Slice amount" value={state.ri_slice_amount} field="ri_slice_amount" dispatch={dispatch} step={0.001} min={0} />
          <NumberField label="Size jitter" value={state.ri_size_jitter_pct} field="ri_size_jitter_pct" dispatch={dispatch} step={0.01} min={0} />
          <NumberField label="Price jitter" value={state.ri_price_jitter_pct} field="ri_price_jitter_pct" dispatch={dispatch} step={0.01} min={0} />
          <NumberField label="Timing jitter" value={state.ri_timing_jitter_pct} field="ri_timing_jitter_pct" dispatch={dispatch} step={0.01} min={0} />
          <NumberField label="Min order interval (s)" value={state.ri_min_order_interval} field="ri_min_order_interval" dispatch={dispatch} step={0.1} min={0} />
          <NumberField label="Expiry (s)" value={state.ri_expiry_seconds} field="ri_expiry_seconds" dispatch={dispatch} step={1} min={0} />
          <NumberField label="Max slippage" value={state.ri_max_slippage} field="ri_max_slippage" dispatch={dispatch} step={0.001} min={0} />
          <TextField label="Random seed" value={state.ri_random_seed} placeholder="optional" onChange={(v) => set("ri_random_seed", v)} />
        </div>
      )}
    </div>
  );
}
