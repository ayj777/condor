/**
 * Client twin of hummingbot `ladder.py`.
 *
 * A quote range spends each rung's share of the quote total at that rung's
 * price, then rounds the base size down onto the amount step. The last rung
 * receives whatever quote is left. A rung below the minimum is dropped.
 */

export type LadderUnit = "BASE" | "QUOTE" | "CONTRACTS";
export type LadderDistribution = "LINEAR" | "GEOMETRIC" | "WEIGHTED";

export interface LadderRung {
  price: number;
  baseAmount: number;
}

export interface RangeLadder {
  levels: LadderRung[];
  baseTotal: number;
  quoteTotal: number;
}

export interface RangeLadderInput {
  total: number;
  unit: LadderUnit;
  priceLow: number;
  priceHigh: number;
  levels: number;
  distribution: LadderDistribution;
  weight: number;
  side: "BUY" | "SELL";
  priceStep: number;
  amountStep: number;
  minAmount: number;
  contractSize?: number;
}

const TINY = 0.0000001;

function finite(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(12)) : 0;
}

/** Largest multiple of `step` that does not exceed `value`. */
export function quantizeDown(value: number, step: number): number {
  if (!(step > 0)) return value;
  if (!(value > 0)) return 0;
  return finite(Math.floor(value / step + 1e-9) * step);
}

function quantizeUp(value: number, step: number): number {
  if (!(step > 0)) return value;
  if (!(value > 0)) return 0;
  return finite(Math.ceil(value / step - 1e-9) * step);
}

/** A tick inside the band. Rounding down, then up off the low if that fell through. */
function clampPrice(price: number, priceLow: number, priceHigh: number, step: number): number {
  let next = price;
  if (next < priceLow) next = priceLow;
  if (next > priceHigh) next = priceHigh;
  if (!(step > 0)) return next;
  let quantized = quantizeDown(next, step);
  if (quantized < priceLow) quantized = quantizeUp(priceLow, step);
  if (quantized < priceLow || quantized > priceHigh) {
    throw new Error(`No price tick falls inside [${priceLow}, ${priceHigh}] with step ${step}.`);
  }
  return quantized;
}

function ladderPrices(input: RangeLadderInput): number[] {
  const { priceLow, priceHigh, levels, distribution, side, priceStep } = input;
  if (levels === 1) {
    const anchor = side === "BUY" ? priceLow : priceHigh;
    return [clampPrice(anchor, priceLow, priceHigh, priceStep)];
  }
  const prices: number[] = [];
  for (let index = 0; index < levels; index += 1) {
    const fraction = index / (levels - 1);
    const raw = distribution === "GEOMETRIC"
      ? priceLow * (priceHigh / priceLow) ** fraction
      : priceLow + (priceHigh - priceLow) * fraction;
    prices.push(clampPrice(raw, priceLow, priceHigh, priceStep));
  }
  return prices;
}

function ladderWeights(levels: number, weight: number): number[] {
  if (levels === 1) return [1];
  const raw: number[] = [];
  for (let index = 0; index < levels; index += 1) {
    const position = (2 * index) / (levels - 1) - 1;
    raw.push(Math.max(1 + weight * position, TINY));
  }
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

function fromBase(
  totalBase: number,
  prices: number[],
  weights: number[],
  amountStep: number,
  minAmount: number,
): LadderRung[] {
  let remaining = totalBase;
  const levels: LadderRung[] = [];
  for (let index = 0; index < prices.length; index += 1) {
    const piece = index === prices.length - 1 ? remaining : totalBase * weights[index];
    const amount = quantizeDown(Math.min(piece, remaining), amountStep);
    if (amount >= minAmount && amount > 0) {
      levels.push({ price: prices[index], baseAmount: amount });
      remaining = finite(remaining - amount);
    }
    if (remaining <= 0) break;
  }
  return levels;
}

function fromQuote(
  totalQuote: number,
  prices: number[],
  weights: number[],
  amountStep: number,
  minAmount: number,
): LadderRung[] {
  let remaining = totalQuote;
  const levels: LadderRung[] = [];
  for (let index = 0; index < prices.length; index += 1) {
    const price = prices[index];
    if (!(price > 0) || remaining <= 0) break;
    const piece = index === prices.length - 1 ? remaining : totalQuote * weights[index];
    const amount = quantizeDown(Math.min(piece, remaining) / price, amountStep);
    if (amount >= minAmount && amount > 0) {
      levels.push({ price, baseAmount: amount });
      remaining = finite(remaining - amount * price);
    }
  }
  return levels;
}

/** The rungs a range iceberg will try to place. Throws when rounding leaves nothing. */
export function buildRangeLadder(input: RangeLadderInput): RangeLadder {
  if (!(input.levels >= 1)) throw new Error("levels must be at least 1");
  if (!(input.priceLow > 0) || !(input.priceHigh > 0) || input.priceLow > input.priceHigh) {
    throw new Error("price range must be positive and low must not exceed high");
  }
  if (!(input.total > 0)) throw new Error("The range ladder is below the minimum order size after rounding.");
  const contract = input.contractSize != null && input.contractSize > 0 ? input.contractSize : 1;
  const prices = ladderPrices(input);
  const weights = ladderWeights(prices.length, input.weight);
  const minAmount = input.minAmount > 0 ? input.minAmount : 0;
  const levels = input.unit === "QUOTE"
    ? fromQuote(input.total, prices, weights, input.amountStep, minAmount)
    : fromBase(
      input.unit === "CONTRACTS" ? input.total * contract : input.total,
      prices,
      weights,
      input.amountStep,
      minAmount,
    );
  if (!levels.length) {
    throw new Error("The range ladder is below the minimum order size after rounding.");
  }
  const baseTotal = finite(levels.reduce((sum, level) => sum + level.baseAmount, 0));
  const quoteTotal = finite(levels.reduce((sum, level) => sum + level.price * level.baseAmount, 0));
  return { levels, baseTotal, quoteTotal };
}
