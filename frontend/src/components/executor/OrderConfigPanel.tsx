import { useEffect } from "react";
import { Sparkles } from "lucide-react";

import {
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
import { approximateQuoteLabel, formatTokenAmount, orderStep, plainOrderPrice, plainOrderSentSize, plainOrderSummary, roundDownNote, sizeUnitChoices, sizedPercent, type SizeRule } from "@/lib/order-size";
import { fallbackStrategy } from "@/lib/order-strategy";
import { bookForOrder, isHedge, isLongSide, orderCap, positionModeLabel, reducesOpen, resultingSize, sideOptions, type HedgeBooks, type OpenBook } from "@/lib/trade-guards";

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
  /** Long and short books. Hedge open and close each use their own side. */
  books?: HedgeBooks;
  /** Sets leverage on its own. Create does not call this. */
  onApplyLeverage?: () => void;
  /** False while the position book is still loading, so Apply cannot use a stale draft. */
  positionsLoaded?: boolean;
  /** True when the position query failed. Apply stays off so it cannot move an unread book. */
  positionsFailed?: boolean;
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
  books = { long: null, short: null },
  onApplyLeverage,
  applyingLeverage = false,
  positionsLoaded = false,
  positionsFailed = false,
  onStrategyHold,
  baseAvailable = null,
  quoteAvailable = null,
  baseSymbol,
  quoteSymbol,
}: Props) {
  const displayBase = baseSymbol || pair?.split("-")[0] || "";
  const displayQuote = quoteSymbol || pair?.split("-")[1] || "";
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

  // Which balance funds the order is not the unit the field shows. A spot BUY
  // spends quote, a spot SELL spends base. A perp spends quote margin either
  // way, and the position it opens is that margin times the leverage. The
  // field itself is quote (USDT) unless the user switches it to the base token.
  const sizingPrice = needsPrice && state.price > 0 ? state.price : currentPrice;
  const orderPrice = plainOrderPrice(state.execution_strategy, state.price, currentPrice);
  const spendsBase = isSpot && state.side === 2;
  const spendable = spendsBase ? baseAvailable : quoteAvailable;
  const spendSymbol = spendsBase ? displayBase : displayQuote;
  const quoteMode = state.amount_unit === "QUOTE";
  const canSize = spendable != null && (
    quoteMode
      ? (!spendsBase || (!!sizingPrice && sizingPrice > 0))
      : (spendsBase || (!!sizingPrice && sizingPrice > 0))
  );
  const sizeCap = orderCap(positionMode, books, openBook ?? null, state.position_action, state.side);
  const symbols = { base: displayBase, quote: displayQuote };
  const sent = plainOrderSentSize(state.amount, state.amount_unit, orderPrice, sizeRule, sizeCap, symbols);
  const summary = plainOrderSummary(state.amount, state.amount_unit, sent, symbols);
  const requestedBase = quoteMode
    ? (orderPrice && orderPrice > 0 ? state.amount / orderPrice : 0)
    : state.amount;
  const rounded = sent.error ? null : roundDownNote(requestedBase, sent.base, displayBase);
  const unitSymbol = quoteMode ? displayQuote : displayBase;

  const pickPercent = (pct: number) => {
    if (spendable === null || spendable <= 0) return;
    const usedLeverage =
      !isSpot && positionLeverage != null && positionLeverage >= 1
        ? positionLeverage
        : state.leverage;
    const next = sizedPercent({
      unit: state.amount_unit,
      spendable,
      pct,
      price: sizingPrice,
      leverage: isSpot ? 1 : usedLeverage,
      spendsBase,
      increment: sizeRule?.increment ?? 0,
    });
    if (next == null) return;
    dispatch({ type: "SET_FIELD", field: "amount", value: next });
  };
  const hedge = isHedge(positionMode);
  const sizeBook = bookForOrder(positionMode, books, openBook, state.side);
  const belowMin = !!sent.error && sent.error.startsWith("Minimum order size");
  const minimumQuote = sizeRule && orderPrice && orderPrice > 0
    ? approximateQuoteLabel(sizeRule.minOrderSize, orderPrice, displayQuote)
    : "";

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
        longLabel={sideOptions(positionMode, openBook, state.position_action)[0]?.label}
        shortLabel={sideOptions(positionMode, openBook, state.position_action)[1]?.label}
      />

      {/* Order Config */}
      <div className="space-y-2.5">
        <SectionHeader>Order</SectionHeader>
        {!isRange && (
        <div>
          <NumberField
            label={unitSymbol ? `Amount (${unitSymbol})` : "Amount"}
            value={state.amount}
            field="amount"
            dispatch={dispatch}
            step={state.amount_unit === "BASE" && sizeRule && sizeRule.increment > 0 ? sizeRule.increment : 0.001}
            min={0}
          />
          <SelectField
            label="Size unit"
            value={state.amount_unit}
            field="amount_unit"
            dispatch={dispatch}
            options={sizeUnitChoices(displayBase, displayQuote)}
          />
          {quoteMode && usesLimitPrice(state.execution_strategy) && state.price > 0 && (
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              A quote amount uses this limit price, so the quote you type is the quote the order spends.
            </p>
          )}
          {sizeRule && state.amount_unit === "BASE" && sizeRule.minOrderSize > 0 && (
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              Step {formatTokenAmount(orderStep(sizeRule) || sizeRule.minOrderSize)}{displayBase ? ` ${displayBase}` : ""}. Minimum {formatTokenAmount(sizeRule.minOrderSize)}{minimumQuote ? ` (${minimumQuote})` : ""}.
            </p>
          )}
          {summary && (
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{summary}</p>
          )}
          {sent.error && state.amount > 0 && (
            <p className="mt-1 text-[10px] text-[var(--color-red)]">{sent.error}</p>
          )}
          {rounded && (
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{rounded}</p>
          )}
          {sent.base > 0 && (sizeBook?.amount || (hedge && state.position_action !== "CLOSE")) ? (
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              After this order the {hedge ? (isLongSide(state.side) ? "long" : "short") : "position"} is {resultingSize(
                sizeBook?.amount ?? 0,
                sent.base,
                hedge ? state.position_action === "CLOSE" : state.position_action === "CLOSE" || reducesOpen(state.side, openBook, positionMode),
              )} {displayBase}.
            </p>
          ) : null}
          {belowMin && sizeRule && (
            <button
              type="button"
              onClick={() =>
                dispatch({
                  type: "SET_FIELD",
                  field: "amount",
                  value: quoteMode && orderPrice && orderPrice > 0
                    ? Number((sizeRule.minOrderSize * orderPrice).toPrecision(8))
                    : sizeRule.minOrderSize,
                })
              }
              className="mt-1 text-[10px] text-[var(--color-primary)] hover:underline"
            >
              Use minimum ({sizeRule.minOrderSize} {displayBase}{minimumQuote ? `, ${minimumQuote}` : ""})
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
                positionsFailed ||
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
          quoteSymbol={displayQuote}
          maxBase={orderCap(positionMode, books, openBook ?? null, state.position_action, state.side)}
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
