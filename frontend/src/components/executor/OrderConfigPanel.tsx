import { useEffect } from "react";
import { Sparkles } from "lucide-react";

import {
  AmountField,
  LeverageField,
  NumberField,
  PercentPresets,
  PriceField,
  SectionHeader,
  SelectField,
  SideSelector,
  ValidationMessages,
} from "./fields";
import type { ExecutorValidation } from "./types";
import { usesLimitPrice, type OrderAction, type OrderState } from "./order-config";
import { RangeIcebergFields } from "./RangeIcebergFields";
import { floorBaseAmount, legalBaseAmount, percentBase, type SizeRule } from "@/lib/order-size";
import { fallbackStrategy } from "@/lib/order-strategy";
import { positionModeLabel, reducesOpen, resultingSize, sideOptions, type OpenBook } from "@/lib/trade-guards";

// ── Execution strategy options ──

const STRATEGY_OPTIONS = [
  { value: "MARKET", label: "Market" },
  { value: "LIMIT", label: "Limit" },
  { value: "LIMIT_MAKER", label: "Limit Maker" },
  { value: "LIMIT_CHASER", label: "Limit Chaser" },
  { value: "RANGE_ICEBERG", label: "Range Iceberg" },
];

const POSITION_ACTION_OPTIONS = [
  { value: "OPEN", label: "Open" },
  { value: "CLOSE", label: "Close" },
];

// ── Panel Component ──

interface Props {
  state: OrderState;
  dispatch: React.Dispatch<OrderAction>;
  validation: ExecutorValidation;
  currentPrice: number | null;
  isSpot?: boolean;
  pair?: string;
  /**
   * Execution strategies this venue allows. A gateway swap has no resting order
   * book, so a DEX passes `["MARKET"]`. Defaults to all of them.
   */
  strategies?: string[];
  /** Margin modes this venue can apply. Empty hides the control. */
  marginModes?: string[];
  /** The pair's minimum size and step. Null until trading rules arrive. */
  sizeRule?: SizeRule | null;
  connector?: string;
  /** Hide the strategy dropdown. The Iceberg tab is that strategy. */
  lockStrategy?: boolean;
  /** Leverage of an open position on this pair, so the form can say it is matching it. */
  positionLeverage?: number | null;
  /** Account position mode, ONEWAY or HEDGE. Empty until the read returns. */
  positionMode?: string;
  /** The open book, used to label a one-way sell and to show the size after this order. */
  openBook?: OpenBook | null;
  /** Sets leverage on its own. Create does not call this. */
  onApplyLeverage?: () => void;
  /** False while the position book is still loading, so Apply cannot use a stale draft. */
  positionsLoaded?: boolean;
  applyingLeverage?: boolean;
  /** True for the frame after a forced strategy change, so Create stays disabled. */
  onStrategyHold?: (held: boolean) => void;
  /** Wallet balance behind the percentage presets; `null` when it is unknown. */
  baseAvailable?: number | null;
  quoteAvailable?: number | null;
  /**
   * Display symbols for the two tokens. A DEX `trading_pair` is
   * `<base_mint>-<quote_symbol>`, so its base half is an address, not a ticker.
   */
  baseSymbol?: string;
  quoteSymbol?: string;
}

export function OrderConfigPanel({
  state,
  dispatch,
  validation,
  currentPrice,
  isSpot = false,
  pair,
  strategies,
  marginModes = [],
  sizeRule = null,
  connector = "",
  lockStrategy = false,
  positionLeverage = null,
  positionMode = "",
  openBook = null,
  onApplyLeverage,
  applyingLeverage = false,
  positionsLoaded = false,
  onStrategyHold,
  baseAvailable = null,
  quoteAvailable = null,
  baseSymbol,
  quoteSymbol,
}: Props) {
  const displayBase = baseSymbol || pair?.split("-")[0] || "base";
  const displayQuote = quoteSymbol || pair?.split("-")[1] || "quote";
  const options = strategies
    ? STRATEGY_OPTIONS.filter((o) => strategies.includes(o.value))
    : STRATEGY_OPTIONS;

  // A strategy the pair does not list falls back to LIMIT, never to MARKET.
  // A resting order is not rewritten into a market order.
  const allowed = options.some((o) => o.value === state.execution_strategy);
  const allowedNames = options.map((o) => o.value).join("|");
  useEffect(() => {
    if (lockStrategy) {
      if (state.execution_strategy !== "RANGE_ICEBERG") {
        dispatch({ type: "SET_FIELD", field: "execution_strategy", value: "RANGE_ICEBERG" });
      }
      return;
    }
    if (allowed) return;
    const next = fallbackStrategy(
      state.execution_strategy,
      allowedNames ? allowedNames.split("|") : [],
    );
    if (!next || next === state.execution_strategy) return;
    onStrategyHold?.(true);
    dispatch({ type: "SET_FIELD", field: "execution_strategy", value: next });
  }, [allowed, allowedNames, lockStrategy, state.execution_strategy, dispatch, onStrategyHold]);

  // Anchor the order price on this market once, so a limit order opens with its
  // line already on the chart and ready to be dragged rather than at 0.
  useEffect(() => {
    if (currentPrice && currentPrice > 0 && !state.anchored) {
      dispatch({ type: "ANCHOR", price: currentPrice });
    }
  }, [currentPrice, state.anchored, dispatch]);

  const needsPrice = allowed && usesLimitPrice(state.execution_strategy);
  const isChaser = allowed && state.execution_strategy === "LIMIT_CHASER";
  const isRange = lockStrategy || (allowed && state.execution_strategy === "RANGE_ICEBERG");

  // The amount is always in base units, but which balance funds it is not: a spot
  // BUY spends quote and has to be divided by the price to become base, a spot
  // SELL spends the base itself. A perp buys margin with quote either way, and the
  // position it opens is that margin times the leverage.
  const sizingPrice = needsPrice && state.price > 0 ? state.price : currentPrice;
  const spendsBase = isSpot && state.side === 2;
  const spendable = spendsBase ? baseAvailable : quoteAvailable;
  const spendSymbol = spendsBase ? displayBase : displayQuote;
  const canSize = spendsBase || (!!sizingPrice && sizingPrice > 0);

  const pickPercent = (pct: number) => {
    if (spendable === null || spendable <= 0) return;
    const spend = spendable * pct;
    const usedLeverage =
      !isSpot && positionLeverage != null && positionLeverage >= 1
        ? positionLeverage
        : state.leverage;
    const stepped = spendsBase
      ? (sizeRule ? floorBaseAmount(spend, sizeRule.increment) : spend)
      : percentBase(spendable, pct, sizingPrice as number, isSpot ? 1 : usedLeverage, sizeRule?.increment ?? 0);
    dispatch({ type: "SET_FIELD", field: "amount", value: Number(stepped.toPrecision(8)) });
  };
  const snapped = sizeRule ? legalBaseAmount(state.amount, sizeRule) : state.amount;
  const belowMin =
    !!sizeRule &&
    sizeRule.minOrderSize > 0 &&
    state.amount > 0 &&
    snapped < sizeRule.minOrderSize;

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-3">
      {/* Direction — Buy/Sell on spot: Long/Short would suggest a perp, and a
          "short" without tokens to sell is not a thing a swap can do. */}
      {positionModeLabel(positionMode) && (
        <p className="text-[10px] text-[var(--color-text-muted)]">
          Position mode: {positionModeLabel(positionMode)}
        </p>
      )}
      <SideSelector
        side={state.side}
        dispatch={dispatch}
        isSpot={isSpot}
        longLabel={sideOptions(positionMode, openBook)[0]?.label}
        shortLabel={sideOptions(positionMode, openBook)[1]?.label}
      />

      {/* Order Config */}
      <div className="space-y-2.5">
        <SectionHeader>Order</SectionHeader>
        {!isRange && (
        <div>
          <AmountField
            value={state.amount}
            field="amount"
            dispatch={dispatch}
            currentPrice={currentPrice}
            step={sizeRule && sizeRule.increment > 0 ? sizeRule.increment : 0.001}
            baseSymbol={displayBase}
            quoteSymbol={displayQuote}
          />
          {sizeRule && sizeRule.minOrderSize > 0 && (
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              Step {sizeRule.increment || sizeRule.minOrderSize} {displayBase}. Minimum {sizeRule.minOrderSize}.
              {state.amount > 0 && snapped !== state.amount && snapped >= sizeRule.minOrderSize
                ? ` This order sends ${snapped}.`
                : ""}
            </p>
          )}
          {openBook && openBook.amount > 0 && snapped > 0 && (
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              After this order the position is {resultingSize(
                openBook.amount,
                snapped,
                state.position_action === "CLOSE" || reducesOpen(state.side, openBook, positionMode),
              )} {displayBase}.
            </p>
          )}
          {belowMin && (
            <button
              type="button"
              onClick={() =>
                dispatch({
                  type: "SET_FIELD",
                  field: "amount",
                  value: sizeRule!.minOrderSize,
                })
              }
              className="mt-1 text-[10px] text-[var(--color-primary)] hover:underline"
            >
              Use minimum ({sizeRule!.minOrderSize} {displayBase})
            </button>
          )}
          <PercentPresets
            available={canSize ? spendable : null}
            symbol={spendSymbol}
            onPick={pickPercent}
            label={`Available ${spendSymbol} to spend`}
          />
        </div>
        )}
        {!lockStrategy && (
        <SelectField
          label="Execution Strategy"
          value={state.execution_strategy}
          field="execution_strategy"
          dispatch={dispatch}
          options={options}
          // A DEX only swaps at market; a one-option dropdown reads as broken.
          disabled={options.length <= 1}
        />
        )}
        <LeverageField value={state.leverage} field="leverage" dispatch={dispatch} isSpot={isSpot} />
        {!isSpot && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-[var(--color-text-muted)]">
              {positionLeverage != null && positionLeverage >= 1
                ? `Orders keep the open ${positionLeverage}x. Apply leverage to change it.`
                : "Apply leverage to set it. Placing an order does not."}
            </p>
            <button
              type="button"
              onClick={() => onApplyLeverage?.()}
              disabled={
                !onApplyLeverage ||
                applyingLeverage ||
                !positionsLoaded ||
                !(state.leverage >= 1) ||
                !state.leverageTouched ||
                (openBook != null && openBook.leverage == null) ||
                (positionLeverage != null && state.leverage === positionLeverage)
              }
              className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
            >
              {applyingLeverage ? "Applying" : "Apply leverage"}
            </button>
          </div>
        )}
        {!isSpot && marginModes.length > 0 && (
          <SelectField
            label="Margin mode"
            value={state.ri_margin_mode}
            field="ri_margin_mode"
            dispatch={dispatch}
            options={marginModes.map((mode) => ({
              value: mode,
              label: mode === "ISOLATED" ? "Isolated" : mode === "CROSS" ? "Cross" : mode,
            }))}
          />
        )}
        {!isSpot && (
          <SelectField
            label="Position Action"
            value={state.position_action}
            field="position_action"
            dispatch={dispatch}
            options={POSITION_ACTION_OPTIONS}
          />
        )}
      </div>

      {isRange && (
        <RangeIcebergFields
          state={state}
          dispatch={dispatch}
          connector={connector}
          sizeRule={sizeRule ?? null}
          baseSymbol={displayBase}
        />
      )}

      {/* Price (for LIMIT strategies) */}
      {needsPrice && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <SectionHeader>Price</SectionHeader>
            {currentPrice && currentPrice > 0 && (
              <button
                onClick={() => dispatch({ type: "SET_FIELD", field: "price", value: currentPrice })}
                className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                <Sparkles className="h-3 w-3" />
                Use current
              </button>
            )}
          </div>
          <PriceField
            label="Order Price"
            value={state.price}
            field="price"
            activePickField={state.activePickField}
            dispatch={dispatch}
            valid={state.price > 0}
          />
        </div>
      )}

      {/* Chaser config */}
      {isChaser && (
        <div className="space-y-2.5">
          <SectionHeader>Chaser Config</SectionHeader>
          <NumberField
            label="Distance"
            value={state.chaser_distance}
            field="chaser_distance"
            dispatch={dispatch}
            step={0.01}
            isPercent
            suffix="%"
          />
          <NumberField
            label="Refresh Threshold"
            value={state.chaser_refresh_threshold}
            field="chaser_refresh_threshold"
            dispatch={dispatch}
            step={0.01}
            isPercent
            suffix="%"
          />
          <p className="text-[10px] text-[var(--color-text-muted)]">
            Chaser continuously adjusts limit order to chase the best price.
          </p>
        </div>
      )}

      <ValidationMessages errors={validation.errors} />
    </div>
  );
}
