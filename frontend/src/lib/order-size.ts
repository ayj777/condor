/**
 * Base-size snapping for venues whose contract step is larger than 1.
 *
 * MEXC perpetual reports `min_base_amount_increment: 10` and `min_order_size: 10`
 * for AIOT-USDT. An amount the form remembers from another venue (a fraction of
 * a coin) is above zero, so the Create button used to enable, and the exchange
 * then rejected the order. The button stays disabled until the size that will
 * actually be sent clears the minimum, and that size is a multiple of the step.
 */

export interface SizeRule {
  minOrderSize: number;
  /** `min_base_amount_increment`. Zero means the venue stated no step. */
  increment: number;
  /** `min_price_increment`. Zero means the venue stated no tick. */
  priceIncrement?: number;
  /** Base coins in one contract. Absent until the trading rules say. */
  contractSize?: number;
}

/** Price used to turn a typed quote amount into base. A limit uses its own price. */
export function quoteTogglePrice(
  limitPrice: number,
  midPrice: number | null,
  usesLimit: boolean,
): number | null {
  if (usesLimit && limitPrice > 0) return limitPrice;
  return midPrice;
}

/**
 * The price a plain market or limit order converts with.
 *
 * A limit uses its limit price and does not fall back to the mid: the base
 * size has to match the price the order will rest at. A market or a chaser
 * uses the current mid or last price.
 */
export function plainOrderPrice(
  strategy: string,
  limitPrice: number,
  midPrice: number | null,
): number | null {
  if (strategy === "LIMIT" || strategy === "LIMIT_MAKER") {
    return limitPrice > 0 ? limitPrice : null;
  }
  return midPrice != null && midPrice > 0 ? midPrice : null;
}

export interface PlainOrderSent {
  /** Base size that will be sent, after the step and the max-size clamp. */
  base: number;
  /** Quote value of that base size, when a price is known. */
  quote: number | null;
  error: string | null;
}

/**
 * The base size a single market or limit order will send.
 *
 * Quote is divided by `price` first. The result is clamped to `maxBase` and
 * then floored to the pair's size step, the same floor a range iceberg uses
 * for one slice. A quote size with no price is not sent.
 */
export function plainOrderSentSize(
  amount: number,
  unit: "BASE" | "QUOTE",
  price: number | null,
  rule: SizeRule | null | undefined,
  maxBase = 0,
  symbols: { base?: string; quote?: string } = {},
): PlainOrderSent {
  const baseSymbol = symbols.base ?? "";
  const quoteSymbol = symbols.quote ?? "";
  if (!(amount > 0)) return { base: 0, quote: null, error: "Amount required" };
  let base = amount;
  if (unit === "QUOTE") {
    if (!(price != null && price > 0)) {
      return {
        base: 0,
        quote: null,
        error: "A price is required to convert quote size into the base token",
      };
    }
    base = amount / price;
  }
  if (maxBase > 0 && base > maxBase) base = maxBase;
  const sent = legalBaseAmount(base, rule);
  const min = rule?.minOrderSize ?? 0;
  const quote = price != null && price > 0 && sent > 0
    ? Number((sent * price).toPrecision(12))
    : null;
  if (!(sent > 0) || (min > 0 && sent < min)) {
    return {
      base: sent,
      quote,
      error: minimumOrderMessage(min > 0 ? min : 0, baseSymbol, price, quoteSymbol),
    };
  }
  return { base: sent, quote, error: null };
}

function minimumOrderMessage(
  min: number,
  baseSymbol: string,
  price: number | null,
  quoteSymbol: string,
): string {
  const baseText = [String(min), baseSymbol].filter(Boolean).join(" ");
  const note = approximateQuoteLabel(min, price, quoteSymbol);
  return note
    ? `Minimum order size is ${baseText} (${note})`
    : `Minimum order size is ${baseText}`;
}

/**
 * One line for the amount the user typed and the base size that will be sent.
 *
 * Quote mode leads with the typed quote and the base equivalent. Base mode
 * leads with the base size and, when a price is known, its approximate quote.
 */
export function plainOrderSummary(
  typed: number,
  unit: "BASE" | "QUOTE",
  sent: PlainOrderSent,
  symbols: { base?: string; quote?: string },
): string | null {
  if (sent.error || !(sent.base > 0)) return null;
  const baseText = [formatTokenAmount(sent.base), symbols.base || ""].filter(Boolean).join(" ");
  if (unit === "QUOTE") {
    const typedText = [formatTokenAmount(typed), symbols.quote || ""].filter(Boolean).join(" ");
    const drifted = sent.quote != null
      && symbols.quote
      && Math.abs(sent.quote - typed) > Math.max(1e-8, Math.abs(typed) * 1e-6);
    const approx = drifted ? ` (approx ${formatTokenAmount(sent.quote as number)} ${symbols.quote})` : "";
    return `${typedText}, about ${baseText}${approx}`;
  }
  const note = approximateQuoteLabel(sent.base, sent.quote != null && sent.base > 0 ? sent.quote / sent.base : null, symbols.quote || "");
  return note ? `${baseText} (${note})` : baseText;
}

/** `approx 3.2 USDT`, or empty when the price or the quote ticker is missing. */
export function approximateQuoteLabel(
  base: number,
  price: number | null | undefined,
  quote: string,
): string {
  if (!(base > 0) || price == null || !(price > 0) || !quote || !Number.isFinite(base) || !Number.isFinite(price)) {
    return "";
  }
  const quoteAmount = Number((base * price).toPrecision(12));
  return `approx ${formatTokenAmount(quoteAmount)} ${quote}`;
}

/** The base text plus its approximate quote, when that quote can be priced. */
export function withApproximateQuote(
  text: string,
  base: number,
  price: number | null | undefined,
  quote: string,
): string {
  const note = approximateQuoteLabel(base, price, quote);
  return note ? `${text} (${note})` : text;
}

/**
 * Price for a displayed base size.
 *
 * An average fill wins. With no fill price, the executor's own mid or the
 * page mid is used. A limit on the order is not treated as a fill.
 */
export function referenceSizePrice(
  sources: Array<Record<string, unknown> | null | undefined>,
  mark?: number | null,
): number | null {
  const averages = [
    "average_fill_price",
    "avg_fill_price",
    "average_filled_price",
    "average_entry_price",
    "current_position_average_price",
  ];
  for (const key of averages) {
    const value = firstPositive(sources, key);
    if (value != null) return value;
  }
  for (const key of ["current_price", "mid_price", "mark_price"]) {
    const value = firstPositive(sources, key);
    if (value != null) return value;
  }
  return mark != null && mark > 0 ? mark : null;
}

function firstPositive(
  sources: Array<Record<string, unknown> | null | undefined>,
  key: string,
): number | null {
  for (const source of sources) {
    if (!source || !Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = Number(source[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * True when the size on screen is a count of the base token.
 *
 * An iceberg with no stored unit is quote, which is the executor default.
 * A single order with no stored unit is base.
 */
export function sizeShownInBase(unit: string, kind: "iceberg" | "order"): boolean {
  const key = unit.replace(/[\s._-]/g, "").toUpperCase();
  if (key === "QUOTE" || key === "CONTRACTS") return false;
  if (key === "BASE") return true;
  return kind === "order";
}

/**
 * The amount a percent-of-balance button writes into the field.
 *
 * Quote mode stores quote, so a quote balance is used directly (times
 * leverage on a perp) and a base balance is priced into quote. Base mode
 * still returns a floored base size. Null means the price that conversion
 * needs is missing.
 */
export function sizedPercent(args: {
  unit: "BASE" | "QUOTE";
  spendable: number;
  pct: number;
  price: number | null;
  leverage: number;
  spendsBase: boolean;
  increment: number;
}): number | null {
  const { unit, spendable, pct, price, leverage, spendsBase, increment } = args;
  if (!(spendable > 0) || !(pct > 0)) return null;
  const lev = leverage >= 1 ? leverage : 1;
  if (unit === "QUOTE") {
    if (spendsBase) {
      if (!(price != null && price > 0)) return null;
      return Number((spendable * pct * price).toPrecision(8));
    }
    return Number((spendable * pct * lev).toPrecision(8));
  }
  if (spendsBase) {
    const spend = spendable * pct;
    const stepped = increment > 0 ? floorBaseAmount(spend, increment) : spend;
    return Number(stepped.toPrecision(8));
  }
  if (!(price != null && price > 0)) return null;
  return percentBase(spendable, pct, price, lev, increment);
}

/** Nearest multiple of `increment`. An absent step returns `amount` unchanged. */
export function snapBaseAmount(amount: number, increment: number): number {
  if (!(amount > 0) || !(increment > 0) || !Number.isFinite(amount)) return amount > 0 ? amount : 0;
  const steps = Math.round(amount / increment);
  return Number((steps * increment).toPrecision(12));
}

/**
 * Largest multiple of `increment` that does not exceed `amount`.
 *
 * Percent-of-balance sizing uses this so a rounded-up step cannot spend more
 * than the wallet holds.
 */
export function floorBaseAmount(amount: number, increment: number): number {
  if (!(amount > 0) || !(increment > 0) || !Number.isFinite(amount)) return amount > 0 ? amount : 0;
  const steps = Math.floor(amount / increment + 1e-9);
  return Number((steps * increment).toPrecision(12));
}

/**
 * Base size for a percent of the quote balance.
 *
 * `leverage` is the leverage the order will actually use, which is the open
 * position's leverage when one is open.
 */
export function percentBase(
  spendable: number,
  pct: number,
  price: number,
  leverage: number,
  increment: number,
): number {
  if (!(spendable > 0) || !(pct > 0) || !(price > 0) || !(leverage >= 1)) return 0;
  return floorBaseAmount((spendable * pct * leverage) / price, increment);
}

/**
 * The step a base size must land on.
 *
 * A known contract size wins when it is coarser than the base increment, so a
 * typed size is a whole number of contracts before it is sent. The connector
 * still turns that base size into contracts.
 */
export function orderStep(rule: SizeRule | null | undefined): number {
  const contract = rule?.contractSize ?? 0;
  const increment = rule?.increment ?? 0;
  if (contract > 0 && increment > 0) return Math.max(contract, increment);
  return contract > 0 ? contract : increment;
}

/** The base amount a create will submit. Floored to the step, never rounded up. */
export function legalBaseAmount(amount: number, rule: SizeRule | null | undefined): number {
  if (!(amount > 0)) return 0;
  const step = orderStep(rule);
  if (!(step > 0)) return amount;
  return floorBaseAmount(amount, step);
}

/** `30,000` for a token amount. Grouping is the only decoration. */
export function formatTokenAmount(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  return amount.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** Shown when the size that will be sent is smaller than the size that was typed. */
export function roundDownNote(typed: number, sent: number, symbol: string): string | null {
  if (!(sent > 0) || !(typed > sent + 1e-9) || !symbol) return null;
  return `Rounded down to ${formatTokenAmount(sent)} ${symbol}.`;
}

/** The two tickers on `AIOT-USDT`. Empty when that half of the pair is missing. */
export function pairTokens(pair: string | null | undefined): { base: string; quote: string } {
  const [base, quote] = (pair || "").split("-");
  return { base: base || "", quote: quote || "" };
}

/**
 * The token a stored size unit names.
 *
 * `BASE` and a leftover `CONTRACTS` row use the base ticker. `QUOTE` uses the
 * quote ticker. The words themselves are not shown.
 */
export function sizeUnitSymbol(unit: string, pair: string | null | undefined): string {
  const { base, quote } = pairTokens(pair);
  const key = unit.replace(/[\s._-]/g, "").toUpperCase();
  if (quote && (key === "QUOTE" || key === quote.toUpperCase())) return quote;
  if (base && (key === "BASE" || key === "CONTRACTS" || key === base.toUpperCase() || key === "")) return base;
  return quote || base;
}

/** The size-unit choices a form may offer: the pair's own tickers, nothing else. */
export function sizeUnitChoices(base: string, quote: string): { value: "BASE" | "QUOTE"; label: string }[] {
  return [
    { value: "BASE", label: base },
    { value: "QUOTE", label: quote },
  ];
}

/** Nearest tick. An absent increment leaves the price unchanged. */
export function quantizePrice(price: number, increment: number): number {
  if (!(price > 0) || !(increment > 0) || !Number.isFinite(price)) return price > 0 ? price : 0;
  const steps = Math.round(price / increment);
  return Number((steps * increment).toPrecision(12));
}

/**
 * Why this amount cannot be sent, or null when the snapped size is legal.
 *
 * A size that floors onto a legal step is sent as that smaller size, and the
 * form says so. A size that floors below the minimum is not. The message
 * names the minimum in the base asset.
 */
export function baseAmountError(
  amount: number,
  rule: SizeRule | null | undefined,
  baseSymbol: string,
): string | null {
  if (!(amount > 0)) return "Amount required";
  if (!rule) return null;
  const snapped = legalBaseAmount(amount, rule);
  const min = rule.minOrderSize > 0 ? rule.minOrderSize : 0;
  if (min > 0 && snapped < min) {
    return `Minimum order size is ${min} ${baseSymbol}`;
  }
  return null;
}
