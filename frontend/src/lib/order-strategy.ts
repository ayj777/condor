/**
 * Which strategy the form keeps when the pair's rules change.
 *
 * A resting order (limit, maker, chaser, iceberg) is never rewritten to a
 * market order. The fallback is LIMIT when the pair allows it, otherwise the
 * first allowed strategy that is not MARKET. A market-only pair keeps the
 * resting strategy, and Create stays disabled because it is not allowed.
 */

const RESTING = new Set(["LIMIT", "LIMIT_MAKER", "LIMIT_CHASER", "RANGE_ICEBERG"]);

export function fallbackStrategy(
  current: string,
  allowed: string[],
): string | null {
  const names = allowed.map((item) => item.toUpperCase());
  if (names.includes(current.toUpperCase())) return null;
  if (RESTING.has(current.toUpperCase())) {
    if (names.includes("LIMIT")) return "LIMIT";
    const other = names.find((item) => item !== "MARKET");
    return other ?? null;
  }
  if (names.includes("LIMIT")) return "LIMIT";
  const other = names.find((item) => item !== "MARKET");
  if (other) return other;
  return names[0] ?? null;
}
