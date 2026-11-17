import type { ExecutorType } from "@/components/executor/types";

/**
 * What a venue can do in the trade panel.
 *
 * This is the one place that maps *facts about a venue* to *UI decisions*, and the
 * facts arrive from the server as independent traits (`GET /market/venues`) rather
 * than being guessed here. Nothing about a venue is inferred from its name: the
 * backend already carries four mutually inconsistent connector predicates (prefix
 * lists, substring lists, live gateway lookups) that disagree on cases like
 * `binance-smart-chain`, and a fifth one in the frontend would drift the same way.
 *
 * It is also not inferred from *one* trait standing in for several. The panel asks
 * four different questions — which executor tabs exist, which execution strategies
 * exist, whether the Hummingbot market endpoints are called, and where the current
 * price comes from — and they do not have a common answer. `xrpl` is the venue that
 * proves it: a first-class Hummingbot connector with a real order book whose charts
 * nonetheless come from GeckoTerminal. A `cex`/`dex` binary keyed on chart source
 * silently strips its book; two independent traits cannot.
 *
 * The executor-type and strategy maps below *are* frontend literals, deliberately:
 * they are a UI product decision about which tabs and options to render, not a
 * server fact, and they are changed by whoever changes the tabs.
 */

/** A venue's independent traits, as `GET /market/venues` reports them. */
export interface VenueTraits {
  name: string;
  /** `/market/trading-rules`, `/market/order-book`, `/market/tickers`, `/market/prices` answer. */
  hummingbotMarketData: boolean;
  /** This venue can take an `lp_executor` CLMM position. */
  clmmLp: boolean;
  /**
   * The account holds credentials for this venue, so an executor created here
   * has something to execute against. False means the venue reached the list on
   * its market data alone: every read works, nothing can be traded.
   */
  credentialed: boolean;
}

/**
 * Facts recorded for a connector whose name is not a sufficient description.
 *
 * The venue list still decides whether the book, the rules and the credentials
 * exist. This only adds what those traits cannot say: margin modes, whether a
 * range iceberg order is a real executor here, and which order types the
 * connector accepts when a pair has not reported its own. Unknown venues get
 * no profile, and every capability they already had stays as it was.
 */
export interface TradingProfile {
  perpetual: boolean;
  leverage: boolean;
  marginModes: string[];
  positionModes: string[];
  orderTypes: string[];
  reduceOnly: boolean;
  rangeIceberg: boolean;
  /** A limit or market order has to set leverage on the account before create. */
  confirmsAccountSettings: boolean;
  /**
   * The range iceberg executor treats a missing margin mode as "do not touch
   * margin". True only where that executor is deployed. The MEXC value
   * requires ayj777/hummingbot PR 3 or later.
   */
  rangeIcebergOmitsMargin: boolean;
}

const TRADING_PROFILES: Record<string, TradingProfile> = {
  mexc_perpetual: {
    perpetual: true,
    leverage: true,
    marginModes: ["ISOLATED", "CROSS"],
    // The connector supports both. It reads the account's mode from MEXC and
    // refuses to trade until that read succeeds, so the form does not set it.
    positionModes: ["ONEWAY", "HEDGE"],
    orderTypes: ["LIMIT", "MARKET", "LIMIT_MAKER"],
    reduceOnly: true,
    rangeIceberg: true,
    confirmsAccountSettings: true,
    // Requires ayj777/hummingbot PR 3 or later.
    rangeIcebergOmitsMargin: true,
  },
};

export function tradingProfile(connector: string): TradingProfile | null {
  return TRADING_PROFILES[connector] ?? null;
}

export interface ConnectorCapabilities {
  /** Executor types this venue supports. */
  executorTypes: ExecutorType[];
  /** Allowed `execution_strategy` values (subset of OrderConfigPanel's options). */
  orderStrategies: string[];
  /** Margin modes the order form may offer. Empty means the form shows none. */
  marginModes: string[];
  /** Whether this venue's account settings are applied before a plain order. */
  confirmsAccountSettings: boolean;
  /** Whether a range iceberg may omit margin. False refuses the iceberg. */
  rangeIcebergOmitsMargin: boolean;
  /** Whether `/market/order-book` and `/market/tickers` answer — depth + markets tabs. */
  hasOrderBook: boolean;
  /** Whether `/market/trading-rules` answers — pair list + price precision. */
  hasTradingRules: boolean;
  /** Whether `/market/prices` answers — otherwise the price comes off the candle stream. */
  hasRestPrice: boolean;
  /** Whether the LP tab is offered. */
  supportsLp: boolean;
  /**
   * Whether an executor can actually be created here. The only capability that
   * rests on credentials rather than on market data — a view-only venue keeps
   * its book, its rules and its strategies, and loses just the account to
   * execute against.
   */
  canTrade: boolean;
}

/**
 * The traits assumed for a venue we have no answer for — including every venue
 * before the query resolves. Full Hummingbot capabilities: the status quo for every
 * venue the panel handled before DEX support existed, so the pending state never
 * flashes DEX-restricted UI.
 */
const UNKNOWN_VENUE: VenueTraits = {
  name: "",
  hummingbotMarketData: true,
  clmmLp: false,
  // Credentialed, emphatically: this is the answer for every venue until the
  // venues query resolves, and a `false` here would blur the Execute panel on
  // every single page load before settling back a moment later.
  credentialed: true,
};

/**
 * Capabilities of `connector`, given what the server says about the venues.
 *
 * Each UI consequence is traced to the single trait that justifies it, and the two
 * traits are read independently — that is what stops an order-book venue from being
 * offered an LP tab, and a swap venue from being denied one.
 */
export function connectorCapabilities(
  connector: string,
  venues: VenueTraits[] | Map<string, VenueTraits>,
): ConnectorCapabilities {
  const traits =
    (venues instanceof Map
      ? venues.get(connector)
      : venues.find((v) => v.name === connector)) ?? UNKNOWN_VENUE;

  const profile = tradingProfile(connector);
  // Without a Hummingbot market feed there is no resting order book to post to, so
  // MARKET is the only execution strategy that means anything, and the executors
  // that manage resting orders (position/grid/dca) have nothing to manage.
  const executorTypes: ExecutorType[] = traits.hummingbotMarketData
    ? ["order", "position", "grid", "dca"]
    : ["order"];
  // Its own tab, beside Order. The order dropdown also lists the strategy, so
  // either door submits a range_iceberg_executor.
  if (profile?.rangeIceberg) {
    const afterOrder = executorTypes.indexOf("order");
    executorTypes.splice(afterOrder + 1, 0, "iceberg");
  }
  if (traits.clmmLp) executorTypes.push("lp");
  const orderStrategies = traits.hummingbotMarketData
    ? ["MARKET", "LIMIT", "LIMIT_MAKER", "LIMIT_CHASER"]
    : ["MARKET"];
  // Range iceberg is an executor, not a native order type, so it is added
  // rather than filtered out of the list the other venues already share.
  if (profile?.rangeIceberg && !orderStrategies.includes("RANGE_ICEBERG")) {
    orderStrategies.push("RANGE_ICEBERG");
  }

  return {
    executorTypes,
    orderStrategies,
    marginModes: profile?.marginModes ?? [],
    confirmsAccountSettings: profile?.confirmsAccountSettings ?? false,
    rangeIcebergOmitsMargin: profile?.rangeIcebergOmitsMargin ?? false,
    hasOrderBook: traits.hummingbotMarketData,
    hasTradingRules: traits.hummingbotMarketData,
    hasRestPrice: traits.hummingbotMarketData,
    supportsLp: traits.clmmLp,
    canTrade: traits.credentialed,
  };
}

/**
 * The venues the trade panel offers, credentialed ones first.
 *
 * Trade is for venues with an order book — whether or not the venue is
 * decentralized: hyperliquid and xrpl belong here, solana-mainnet-beta does not.
 * Everything Condor trades through Gateway lives on /dex instead, where the pool
 * rather than the pair is the unit of navigation.
 *
 * The order is load-bearing twice over: it is the order the selector groups into
 * `Your accounts` / `View only`, and the first entry is the panel's reset
 * fallback — which should land on a venue you can trade whenever one exists.
 * Within each group the server's order is kept, so this is a stable partition
 * rather than a sort.
 */
export function orderBookVenues(venues: VenueTraits[]): string[] {
  const offered = venues.filter((v) => v.hummingbotMarketData);
  return [
    ...offered.filter((v) => v.credentialed).map((v) => v.name),
    ...offered.filter((v) => !v.credentialed).map((v) => v.name),
  ];
}
