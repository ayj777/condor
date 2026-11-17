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
