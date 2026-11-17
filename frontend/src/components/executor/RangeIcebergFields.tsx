import { useState } from "react";

import type { SizeRule } from "@/lib/order-size";
import { formatInterval, icebergSentSize, rangeIcebergPreview } from "@/lib/range-iceberg";
import { rangeIcebergInput, type OrderAction, type OrderState } from "./order-config";
import { NumberField, PriceField, SectionHeader, SelectField } from "./fields";

/**
 * The range iceberg executor's fields, in the order the config declares them.
 *
 * Amounts are in the selected size unit. On MEXC a BASE amount is converted
 * by the contract size (AIOT-USDT is 10), so the form does not divide by it.
 */

const MODE_OPTIONS = [
  { value: "RANGE", label: "Range" },
  { value: "UP_TO", label: "Up to" },
];
const UNIT_OPTIONS = [
  { value: "BASE", label: "Base" },
  { value: "QUOTE", label: "Quote" },
  { value: "CONTRACTS", label: "Contracts" },
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
}: {
  state: OrderState;
  dispatch: React.Dispatch<OrderAction>;
  connector: string;
  sizeRule: SizeRule | null;
  baseSymbol: string;
}) {
  const [advanced, setAdvanced] = useState(state.ri_show_advanced);
  const set = (field: string, value: unknown) =>
    dispatch({ type: "SET_FIELD", field, value });
  const input = rangeIcebergInput(state);
  const preview = rangeIcebergPreview(input);
  const price = state.ri_mode === "UP_TO"
    ? state.ri_limit_price
    : Math.max(state.ri_price_low, state.ri_price_high);
  const sent = icebergSentSize(input, sizeRule, price, state.ri_contracts_confirmed);

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
        label={`Total amount (${state.ri_size_unit.toLowerCase()})`}
        value={state.ri_total_amount}
        field="ri_total_amount"
        dispatch={dispatch}
        step={sizeRule && state.ri_size_unit === "BASE" && sizeRule.increment > 0 ? sizeRule.increment : 0.001}
        min={0}
      />
      {state.ri_size_unit === "QUOTE" && sent.error == null && sent.total > 0 && (
        <p className="text-[10px] text-[var(--color-text-muted)]">
          This order sends {sent.total} {baseSymbol}, {sent.perSlice} per slice.
        </p>
      )}
      {sizeRule && state.ri_size_unit === "BASE" && sizeRule.minOrderSize > 0 && (
        <p className="text-[10px] text-[var(--color-text-muted)]">
          Step {sizeRule.increment || sizeRule.minOrderSize} {baseSymbol}. Minimum {sizeRule.minOrderSize}.
          {sent.error == null && sent.total !== state.ri_total_amount
            ? ` This order sends ${sent.total}, ${sent.perSlice} per slice.`
            : ""}
        </p>
      )}
      {state.ri_size_unit === "CONTRACTS" && (
        <label className="flex cursor-pointer items-center gap-2 text-[10px] text-[var(--color-text)]">
          <input
            type="checkbox"
            checked={state.ri_contracts_confirmed}
            onChange={(e) => set("ri_contracts_confirmed", e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-primary)]"
          />
          I mean contracts, not base coins
        </label>
      )}
      <SelectField
        label="Size unit"
        value={state.ri_size_unit}
        field="ri_size_unit"
        dispatch={dispatch}
        options={UNIT_OPTIONS}
      />
      {connector === "mexc_perpetual" && (
        <p className="text-[10px] text-[var(--color-text-muted)]">
          Amounts stay in the unit you pick. MEXC converts base size by the contract size (AIOT-USDT is 10). Child orders wait at least {state.ri_min_order_interval}s, inside the 4 requests per 2 seconds limit.
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
      {preview && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[10px] text-[var(--color-text-muted)]">
          <p className="font-medium text-[var(--color-text)]">Preview</p>
          <p>Total {sent.error ? preview.total : sent.total} {state.ri_size_unit.toLowerCase()}</p>
          <p>Per slice {Number((sent.error ? preview.perSlice : sent.perSlice).toPrecision(6))} across {preview.sliceCount}</p>
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
