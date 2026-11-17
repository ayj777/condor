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

/** The base amount a create will submit, after the venue's step. */
export function legalBaseAmount(amount: number, rule: SizeRule | null | undefined): number {
  if (!(amount > 0)) return 0;
  if (!rule || !(rule.increment > 0)) return amount;
  return snapBaseAmount(amount, rule.increment);
}

/**
 * Why this amount cannot be sent, or null when the snapped size is legal.
 *
 * A size that merely sits between two steps is legal: the create sends the
 * snapped multiple, and the form says so. A size that snaps below the minimum
 * is not, and the message names the minimum in the base asset.
 */
export function baseAmountError(
  amount: number,
  rule: SizeRule | null | undefined,
  baseSymbol: string,
): string | null {
  if (!(amount > 0)) return "Amount required (base currency)";
  if (!rule) return null;
  const snapped = legalBaseAmount(amount, rule);
  const min = rule.minOrderSize > 0 ? rule.minOrderSize : 0;
  if (min > 0 && snapped < min) {
    return `Minimum order size is ${min} ${baseSymbol}`;
  }
  return null;
}
