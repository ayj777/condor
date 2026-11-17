import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpDown,
  BarChart3,
  ChevronDown,
  Droplets,
  Grid3X3,
  Layers,
  Loader2,
  Rows3,
  Rocket,
  Settings2,
  TrendingUp,
} from "lucide-react";

import { NoServerCard } from "@/components/NoServerCard";
import { useTradingRules } from "@/components/market/useTradingRules";
import { useVenues } from "@/components/market/useVenues";
import { PriceTicker } from "@/components/market/PriceTicker";
import { MarketDepthPanel } from "@/components/market/MarketDepthPanel";
import { MarketBrowser, type MarketPick } from "@/components/market/MarketBrowser";
import { FavoritesStrip } from "@/components/market/FavoritesStrip";
import { StarMarketButton } from "@/components/market/StarMarketButton";
import { TradeChart } from "@/components/trade/TradeChart";
import { GridConfigPanel } from "@/components/grid/GridConfigPanel";
import {
  ErrorToast,
  ExecutorSuccessModal,
} from "@/components/executor/ExecutorSuccessModal";
import { PositionConfigPanel } from "@/components/executor/PositionConfigPanel";
import { usePositionConfig } from "@/components/executor/position-config";
import { OrderConfigPanel } from "@/components/executor/OrderConfigPanel";
import { useOrderConfig } from "@/components/executor/order-config";
import { DCAConfigPanel } from "@/components/executor/DCAConfigPanel";
import { useDCAConfig } from "@/components/executor/dca-config";
import { LPConfigPanel } from "@/components/executor/LPConfigPanel";
import { LP_SIDE_RANGE, useLpConfig } from "@/components/executor/lp-config";
import { useGridConfig } from "@/components/executor/grid-config";
import { HintBubble } from "@/components/ui/HintBubble";
import { useOneTimeHint } from "@/hooks/useOneTimeHint";
import { ExecutorTypeSelect } from "@/components/trade/ExecutorTypeSelect";
import { TradeBottomPane } from "@/components/trade/TradeBottomPane";
import { ViewOnlyOverlay } from "@/components/trade/ViewOnlyOverlay";
import { useLastClose } from "@/hooks/useCandleStore";
import { usePairBalances } from "@/hooks/usePairBalances";
import { useServer } from "@/hooks/useServer";
import { useCondorWebSocket } from "@/hooks/useWebSocket";
import { useMainControllerData } from "@/hooks/useMainControllerData";
import { useResizeDrag } from "@/hooks/useResizeDrag";
import { api } from "@/lib/api";
import { candleStore } from "@/lib/candle-store";
import { connectorCapabilities, orderBookVenues } from "@/lib/connector-capabilities";
import { executorsQuery } from "@/lib/queryClient";
import { BROWSE_HINT_KEY } from "@/lib/sessionState";
import type { ChartPriceMapping, ExecutorType, PickSlot } from "@/components/executor/types";
import {
  hasRememberedMarket,
  isSpotConnector,
  LAST_MARKET_KEY,
  INTERVALS,
  LOOKBACK_OPTIONS,
} from "@/lib/gridExecutor";
import { formatConnectorName, formatPriceSig } from "@/lib/formatters";
import { baseAmountError, legalBaseAmount } from "@/lib/order-size";
import { applyHedge, applyReducing, canonicalPositionMode, claimInflight, ICEBERG_MARGIN_HOLD, icebergCreateHeld, isHedge, marginForOpen, MARGIN_CHOOSE, orderCap, ordersBlockCreate, positionModeBlocksCreate, sideHasOpenPosition, type HedgeBooks, type OpenBook } from "@/lib/trade-guards";
import { useViewFacts } from "@/lib/viewFacts";

// ── Type tabs config ──

const TYPE_TABS: { value: ExecutorType; label: string; icon: React.ReactNode }[] = [
  { value: "order", label: "Order", icon: <ArrowUpDown className="h-3.5 w-3.5" /> },
  { value: "iceberg", label: "Iceberg", icon: <Rows3 className="h-3.5 w-3.5" /> },
  { value: "position", label: "Position", icon: <TrendingUp className="h-3.5 w-3.5" /> },
  { value: "grid", label: "Grid", icon: <Grid3X3 className="h-3.5 w-3.5" /> },
  { value: "dca", label: "DCA", icon: <Layers className="h-3.5 w-3.5" /> },
  { value: "lp", label: "LP", icon: <Droplets className="h-3.5 w-3.5" /> },
];

const TYPE_LABELS: Record<ExecutorType, string> = {
  grid: "Grid Executor",
  position: "Position Executor",
  order: "Order Executor",
  iceberg: "Range Iceberg",
  dca: "DCA Executor",
  lp: "LP Executor",
};

// ── Page ──

export function CreateExecutor() {
  const { server } = useServer();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Executor type from URL param or default to grid
  const [executorType, setExecutorType] = useState<ExecutorType>(
    () => (searchParams.get("type") as ExecutorType) || "grid",
  );

  // Update URL when type changes
  const handleTypeChange = (type: ExecutorType) => {
    setExecutorType(type);
    setSearchParams({ type }, { replace: true });
  };

  // ── Executor configs (all initialized for hooks rules) ──
  //
  // The grid's is destructured as well: its state carries the page's market
  // (connector, pair, interval, lookback), which every tab reads and several
  // effects dispatch into, so those two stay in scope under their own names.
  const gridConfig = useGridConfig();
  const { state: gridState, dispatch: gridDispatch } = gridConfig;
  const positionConfig = usePositionConfig();
  const dcaConfig = useDCAConfig();

  // ── Shared market state ──
  // Use grid state for connector/pair/interval since it's always present
  // Sync other types' connector/pair changes through grid state
  const connector = gridState.connector;
  const pair = gridState.pair;
  const isSpot = isSpotConnector(connector);
  // A CLOB pair is already <BASE>-<QUOTE>, so the tickers come off the split.
  const balances = usePairBalances(
    server ?? null,
    connector,
    pair?.split("-")[0],
    pair?.split("-")[1],
  );

  // The venue the URL asked for, kept after the param is stripped below: the
  // redirect guard cannot read it from the URL any more, and it must not fire
  // for a *persisted* gateway network (that one just resets to a CLOB venue).
  const urlConnectorRef = useRef<string | null>(null);

  // Apply connector/pair from URL params (e.g. from Executors detail panel)
  useEffect(() => {
    const urlConnector = searchParams.get("connector");
    urlConnectorRef.current = urlConnector;
    const urlPair = searchParams.get("pair");
    if (urlConnector) {
      gridDispatch({ type: "SET_CONNECTOR", value: urlConnector });
      searchParams.delete("connector");
    }
    if (urlPair) {
      gridDispatch({ type: "SET_PAIR", value: urlPair });
      searchParams.delete("pair");
    }
    if (urlConnector || urlPair) {
      setSearchParams(searchParams, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [successInfo, setSuccessInfo] = useState<{
    id: string;
    type: ExecutorType;
    connector: string;
    pair: string;
    notice?: string;
  } | null>(null);
  const [rightPanel, setRightPanel] = useState<"config" | "depth">("config");
  // Cold start lands on the market list (FEAT-053): with no remembered market
  // there is nothing to come back to, and the alternative is a chart on a pair
  // the reset effect picked. A URL that names a pair *is* a choice, so it skips
  // the list — the effect above has not stripped the param yet on this render.
  const [browserOpen, setBrowserOpen] = useState(
    () => !searchParams.get("pair") && !hasRememberedMarket(),
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(288);
  const [bottomPaneHeight, setBottomPaneHeight] = useState(200);
  // The selection belongs to the market it was made in, so it carries that
  // market with it and simply stops matching when the market changes. Clearing
  // it from an effect instead used to cost a second render pass on every
  // connector/pair switch, and left one render where the chart still had a
  // selected executor from the market it had already navigated away from.
  const [selection, setSelection] = useState<{ market: string; id: string | null }>({
    market: "",
    id: null,
  });
  const selectionMarket = `${connector}:${pair}`;
  const selectedExecutorId = selection.market === selectionMarket ? selection.id : null;
  const setSelectedExecutorId = useCallback(
    (id: string | null) => setSelection({ market: selectionMarket, id }),
    [selectionMarket],
  );

  const { onMouseDown: startHDrag } = useResizeDrag({
    axis: "x",
    value: rightPanelWidth,
    onChange: setRightPanelWidth,
    min: 260,
    max: 500,
    direction: "inverted",
    cursor: "col-resize",
  });

  const { onMouseDown: startVDrag } = useResizeDrag({
    axis: "y",
    value: bottomPaneHeight,
    onChange: setBottomPaneHeight,
    min: 100,
    max: 500,
    direction: "inverted",
    cursor: "row-resize",
  });

  // One query, one answer: every venue the panel can offer, each with the traits
  // the UI decisions below rest on. Shared with DexPool through `useVenues`, so
  // both pages read the same cached request instead of hand-copying the query.
  const { venues, isPending: venuesPending } = useVenues(server);

  // The list has to be in before the panel may *correct* a selection: judging a
  // persisted venue against an empty list would bounce it on every reload and
  // switch its tab to Order.
  const listsReady = !!server && !venuesPending;

  // Every venue with an order book, credentialed ones first — see
  // `orderBookVenues` for why both halves of that sentence are load-bearing.
  // View-only venues are full members of this list, which is also what keeps the
  // correction effect below from bouncing a persisted one on reload.
  const allConnectors = useMemo(() => orderBookVenues(venues), [venues]);

  // Which of them the account can actually execute on, for the selector's
  // `Your accounts` / `View only` split. Undefined until the query resolves, so
  // the pending list renders flat instead of flashing every venue as view-only.
  const credentialedConnectors = useMemo(
    () =>
      venuesPending
        ? undefined
        : new Set(venues.filter((v) => v.credentialed).map((v) => v.name)),
    [venues, venuesPending],
  );


  const caps = useMemo(
    () => connectorCapabilities(connector, venues),
    [connector, venues],
  );

  // Pool resolution only means something where an LP position can exist, so the
  // query is off elsewhere rather than asking about a pair that has no pool.
  // Declared above the connector/pair propagation effects that dispatch into it.
  const lpConfig = useLpConfig(server ?? null, connector, pair, caps.supportsLp);

  // WS for executor data (candle streams are managed by candleStore)
  const wsChannels = useMemo(
    () => server ? [`executors:${server}`] : [],
    [server],
  );
  useCondorWebSocket(wsChannels, server);

  // Main controller data (executors + positions filtered by connector/pair)
  const { executors: mainExecutors, overlays: mainOverlays, positions: mainPositions, isLoadingPositions, isPositionsError } =
    useMainControllerData(server, connector, pair);

  const rulesData = useTradingRules(server ?? "", connector, caps.hasTradingRules);
  const pairRule = useMemo(() => {
    const rule = rulesData?.rules?.find((r) => r.trading_pair === pair);
    if (!rule) return null;
    return {
      minOrderSize: rule.min_order_size,
      increment: rule.min_base_amount_increment,
      priceIncrement: rule.min_price_increment,
      contractSize: rule.contract_size && rule.contract_size > 0 ? rule.contract_size : undefined,
      orderTypes: rule.supported_order_types ?? [],
    };
  }, [rulesData, pair]);
  const baseSymbol = pair?.split("-")[0] || "";
  // After the rule: the amount check and the snapped size both read it, and a
  // hook above this line would close over a rule from the previous pair.
  const orderConfig = useOrderConfig(pairRule, baseSymbol);
  // The Iceberg tab is the range-iceberg strategy. Setting it during render
  // means the first frame the user can click already submits that executor,
  // rather than a plain order left over from the Order tab.
  if (executorType === "iceberg" && orderConfig.state.execution_strategy !== "RANGE_ICEBERG") {
    orderConfig.dispatch({ type: "SET_FIELD", field: "execution_strategy", value: "RANGE_ICEBERG" });
  }
  const hedgeBooks = useMemo((): HedgeBooks => {
    const asBook = (row: (typeof mainPositions)[number]): OpenBook => {
      const name = (row.position_side || "").toUpperCase();
      const side = name === "SHORT" || name === "SELL" ? "SHORT" : name === "LONG" || name === "BUY" ? "LONG" : "";
      return {
        amount: Math.abs(row.amount),
        side,
        leverage: row.leverage != null && row.leverage >= 1 ? row.leverage : null,
        marginMode: row.margin_mode ?? null,
      };
    };
    const live = mainPositions.filter((p) => Math.abs(p.amount) > 0);
    const pick = (want: "LONG" | "SHORT") => {
      const rows = live.filter((row) => asBook(row).side === want);
      const row = rows.find((item) => item.source === "venue") ?? rows[0];
      return row ? asBook(row) : null;
    };
    return { long: pick("LONG"), short: pick("SHORT") };
  }, [mainPositions]);
  const openBook = hedgeBooks.long ?? hedgeBooks.short;
  const openLeverage = openBook?.leverage ?? null;
  const leverageSeeded = useRef("");
  // During render, so the first click already has the open leverage and Apply
  // cannot send the persisted draft on the frame before an effect runs.
  if (connector && pair && openLeverage != null) {
    const key = `${connector}|${(pair || "").replaceAll("_", "-").toUpperCase()}|${openLeverage}`;
    if (leverageSeeded.current !== key) {
      leverageSeeded.current = key;
      if (orderConfig.state.leverage !== openLeverage) {
        orderConfig.dispatch({ type: "ADOPT_LEVERAGE", value: openLeverage });
      }
      if (positionConfig.state.leverage !== openLeverage) {
        positionConfig.dispatch({ type: "ADOPT_LEVERAGE", value: openLeverage });
      }
    }
  }
  const [strategyHold, setStrategyHold] = useState(false);
  useEffect(() => {
    if (!strategyHold) return;
    const frame = requestAnimationFrame(() => setStrategyHold(false));
    return () => cancelAnimationFrame(frame);
  }, [strategyHold, orderConfig.state.execution_strategy]);
  const positionModeQuery = useQuery({
    queryKey: ["position-mode", server, connector],
    queryFn: () => api.getPositionMode(server!, connector),
    enabled: !!server && !!connector && !isSpot,
    retry: false,
  });
  const ordersHealth = useQuery({
    queryKey: ["active-orders", server, connector, pair],
    queryFn: () => api.getActiveOrders(server!, connector, pair),
    enabled: !!server && !!connector && !!pair && caps.hasOrderBook,
    retry: false,
  });

  const orderStrategies = useMemo(() => {
    const listed = pairRule?.orderTypes ?? [];
    if (!listed.length) return caps.orderStrategies;
    return caps.orderStrategies.filter((strategy) => {
      if (strategy === "RANGE_ICEBERG") return true;
      // A chaser posts limits. It is offered only when the pair accepts them.
      if (strategy === "LIMIT_CHASER") return listed.includes("LIMIT");
      return listed.includes(strategy);
    });
  }, [caps.orderStrategies, pairRule]);

  // Load candles for an executor that's outside the current range
  const handleRequestCandleRange = useCallback((startTime: number) => {
    if (!server) return;
    const newLookback = Math.ceil(Date.now() / 1000 - startTime) + 3600; // +1h padding
    gridDispatch({ type: "SET_FIELD", field: "lookbackSeconds", value: newLookback });
    // `gridDispatch` is the reducer's own dispatch, stable for the page's life;
    // it is named because it now arrives through `gridConfig` rather than
    // straight out of a `useReducer` the compiler can see.
  }, [server, gridDispatch]);

  // Persist last-used connector/pair to localStorage. The executor selection is
  // not cleared here -- it expires on its own, see `selection` above.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_MARKET_KEY, JSON.stringify({ connector, pair }));
    } catch { /* ok */ }
  }, [connector, pair]);

  // A /trade URL naming a gateway network is a link to the wrong page now: its
  // pools, not its pairs, are the thing to pick. Send it to /dex rather than
  // silently swapping in a CEX. Only a *known* non-CLOB venue redirects, so a
  // typo still falls through to the reset below.
  useEffect(() => {
    if (!listsReady) return;
    const wanted = urlConnectorRef.current;
    if (wanted && venues.some((v) => v.name === wanted && !v.hummingbotMarketData)) {
      urlConnectorRef.current = null;
      navigate("/dex", { replace: true });
    }
  }, [listsReady, venues, navigate]);

  // Sync connector to the offered venues. A venue the server no longer reports
  // cannot stay selected, or the panel queries endpoints for a venue that is gone.
  // A persisted solana-mainnet-beta retires itself here — no migration code.
  useEffect(() => {
    if (listsReady && allConnectors.length && !allConnectors.includes(connector)) {
      gridDispatch({ type: "SET_CONNECTOR", value: allConnectors[0] });
    }
  }, [listsReady, allConnectors, connector]);

  // Executor types the venue does not support cannot stay selected (Grid on a CEX
  // → pick a DEX → land on Order).
  useEffect(() => {
    if (listsReady && !caps.executorTypes.includes(executorType)) {
      handleTypeChange("order");
    }
  }, [listsReady, caps, executorType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset pair when connector changes
  useEffect(() => {
    if (rulesData?.rules?.length) {
      const pairs = rulesData.rules.map((r) => r.trading_pair);
      if (!pairs.includes(pair)) {
        const defaultPair = pairs.find((p) => p === "BTC-USDT") ?? pairs[0];
        gridDispatch({ type: "SET_PAIR", value: defaultPair });
      }
    }
  }, [rulesData, connector]); // eslint-disable-line react-hooks/exhaustive-deps

  // Propagate connector/pair changes to other config types
  useEffect(() => {
    positionConfig.dispatch({ type: "SET_CONNECTOR", value: connector });
    orderConfig.dispatch({ type: "SET_CONNECTOR", value: connector });
    dcaConfig.dispatch({ type: "SET_CONNECTOR", value: connector });
    lpConfig.dispatch({ type: "SET_CONNECTOR", value: connector });
  }, [connector]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    positionConfig.dispatch({ type: "SET_PAIR", value: pair });
    orderConfig.dispatch({ type: "SET_PAIR", value: pair });
    dcaConfig.dispatch({ type: "SET_PAIR", value: pair });
    lpConfig.dispatch({ type: "SET_PAIR", value: pair });
  }, [pair]); // eslint-disable-line react-hooks/exhaustive-deps

  // Current price. /market/prices only answers for a Hummingbot connector, so a
  // venue without that trait reads the last close off the candle stream instead. The store is
  // a singleton over one shared channel and TradeChart already subscribes with these
  // exact arguments, so this costs no extra connection.
  const { data: priceData } = useQuery({
    queryKey: ["price", server, connector, pair],
    queryFn: () => api.getPrice(server!, connector, pair),
    enabled: !!server && !!connector && !!pair && caps.hasRestPrice,
    refetchInterval: 5000,
  });

  // Only the last close is read, so only the last close is subscribed: a fresh
  // candle array once a second would re-render this page — chart wrapper, every
  // config panel, the bottom pane — under the user's hands for a scalar that a
  // REST-priced venue never even reads. Gating the server on the capability
  // keeps a CLOB page off the stream entirely; TradeChart holds the channel's
  // own refcounted subscription either way, so the wire is unchanged.
  const lastClose = useLastClose(
    caps.hasRestPrice ? null : (server ?? null),
    connector,
    pair,
    gridState.interval,
  );

  const currentPrice = !caps.hasRestPrice ? lastClose : (priceData?.mid_price ?? null);


  // Price precision
  const pricePrecision = useMemo(() => {
    if (!rulesData?.rules) return undefined;
    const rule = rulesData.rules.find((r) => r.trading_pair === pair);
    if (!rule || !rule.min_price_increment) return undefined;
    const inc = rule.min_price_increment;
    if (inc >= 1) return 0;
    return Math.max(0, Math.ceil(-Math.log10(inc)));
  }, [rulesData, pair]);

  // Depth and Markets have no DEX answer. Derived rather than reset in an effect, so
  // a CEX selection is remembered and comes back when the user returns to a CEX.
  const activePanel = caps.hasOrderBook ? rightPanel : "config";

  // One state, three doors: the Browse button, the "/" key, and the pair
  // selector's footer all land here (FEAT-053).
  const applyMarket = useCallback(
    (market: MarketPick) => {
      if (market.connector !== connector) {
        gridDispatch({ type: "SET_CONNECTOR", value: market.connector });
      }
      gridDispatch({ type: "SET_PAIR", value: market.pair });
      setBrowserOpen(false);
    },
    [connector, gridDispatch],
  );

  // A shortcut nobody can see. The chip used to carry a bare `<kbd>/</kbd>`,
  // which QA reported reading as decoration until they pressed it by accident —
  // a glyph names the key without saying what it opens. So the key is taught in
  // words, on the first hover, once (FEAT-053 follow-up from PR #224 QA).
  const browseHint = useOneTimeHint(BROWSE_HINT_KEY);
  const markBrowseHintTaught = browseHint.markTaught;

  // "/" opens the browser, unless the keystroke belongs to something being
  // typed into. Cmd+K is the chat's (AppShell), so the market list takes the
  // key every other terminal gives a search box.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setBrowserOpen(true);
      // Whoever pressed it does not need to be told it exists.
      markBrowseHintTaught();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [markBrowseHintTaught]);

  // ── Active config derived values ──
  const activeValidation = useMemo(() => {
    const base = (() => {
      switch (executorType) {
        case "grid": return gridConfig.validation;
        case "position": return positionConfig.validation;
        case "order":
        case "iceberg":
          return orderConfig.validation;
        case "dca": return dcaConfig.validation;
        case "lp": return lpConfig.validation;
      }
    })();
    // The order hook already applies the pair's step. Position amounts are
    // base too, and a 0.001 remembered from another venue must not enable a
    // MEXC create that the exchange will reject.
    if (executorType !== "position" || !pairRule) return base;
    const message = baseAmountError(positionConfig.state.amount, pairRule, baseSymbol);
    if (!message || message.startsWith("Amount required")) return base;
    return {
      valid: false,
      errors: [message, ...base.errors.filter((e) => !e.startsWith("Amount"))],
    };
  }, [executorType, gridConfig.validation, positionConfig.validation, positionConfig.state.amount, orderConfig.validation, dcaConfig.validation, lpConfig.validation, pairRule, baseSymbol]);

  // What the form currently says, for the chat bubble (FEAT-060/FEAT-072).
  //
  // The one page that registers its own facts: everywhere else the numbers on
  // screen came out of a react-query cache the fact table can read at send
  // time, but a half-filled order form is local reducer state and no cache
  // holds it. Read at send time like every other contributor, so it is what
  // the user is looking at when they ask — not what they had typed when the
  // bubble was opened.
  //
  // Declared after `activeValidation` so the validation it reports is the one
  // the submit button is reading.
  useViewFacts(() => {
    const side = (n: number) => (n === 1 ? "buy" : "sell");
    const lev = (n: number) => (isSpot ? undefined : `${n}x`);
    const range = (low: number, high: number) =>
      low > 0 || high > 0 ? `${formatPriceSig(low)}–${formatPriceSig(high)}` : undefined;
    const shown: Record<string, string | number | null | undefined> =
      executorType === "grid"
        ? {
            side: side(gridState.side),
            amount: gridState.total_amount_quote,
            range: range(gridState.start_price, gridState.end_price),
            leverage: lev(gridState.leverage),
          }
        : executorType === "position"
          ? {
              side: side(positionConfig.state.side),
              amount: positionConfig.state.amount,
              entry: positionConfig.state.entry_price
                ? formatPriceSig(positionConfig.state.entry_price)
                : "market",
              leverage: lev(positionConfig.state.leverage),
            }
          : executorType === "order"
            ? orderConfig.state.execution_strategy === "RANGE_ICEBERG"
              ? {
                  side: side(orderConfig.state.side),
                  "order type": "Range iceberg",
                  mode: orderConfig.state.ri_mode,
                  amount: orderConfig.state.ri_total_amount,
                  "size unit": orderConfig.state.ri_size_unit,
                  leverage: lev(orderConfig.state.leverage),
                  margin: isSpot ? undefined : orderConfig.state.ri_margin_mode,
                }
              : {
                  side: side(orderConfig.state.side),
                  "order type": orderConfig.state.execution_strategy,
                  amount: orderConfig.state.amount,
                  price:
                    orderConfig.state.execution_strategy === "MARKET"
                      ? undefined
                      : formatPriceSig(orderConfig.state.price),
                  leverage: lev(orderConfig.state.leverage),
                  margin: caps.marginModes.length && !isSpot
                    ? orderConfig.state.ri_margin_mode
                    : undefined,
                }
            : executorType === "iceberg"
              ? {
                  side: side(orderConfig.state.side),
                  "order type": "Range iceberg",
                  mode: orderConfig.state.ri_mode,
                  amount: orderConfig.state.ri_total_amount,
                  "size unit": orderConfig.state.ri_size_unit,
                  leverage: lev(orderConfig.state.leverage),
                  margin: isSpot ? undefined : orderConfig.state.ri_margin_mode,
                }
            : executorType === "dca"
              ? {
                  side: side(dcaConfig.state.side),
                  orders: dcaConfig.state.amounts_quote.length,
                  amount: dcaConfig.state.amounts_quote.reduce((a, b) => a + b, 0),
                  leverage: lev(dcaConfig.state.leverage),
                }
              : {
                  side:
                    lpConfig.state.side === LP_SIDE_RANGE
                      ? "range"
                      : side(lpConfig.state.side),
                  base: lpConfig.state.base_amount || undefined,
                  quote: lpConfig.state.quote_amount || undefined,
                  range: range(lpConfig.state.lower_price, lpConfig.state.upper_price),
                  pool: lpConfig.state.pool_address || undefined,
                };
    // R2/R3: the two facts a user on this form actually asks about — what
    // they have to spend, and why the button is greyed out.
    shown["available"] =
      balances.quote != null && pair
        ? `${balances.quote.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${pair.split("-")[1]}`
        : undefined;
    shown["blocked by"] = activeValidation.valid
      ? undefined
      : activeValidation.errors[0];
    return {
      label: "Trade",
      subject: `a ${TYPE_LABELS[executorType]} on ${connector} ${pair}`,
      onScreen: shown,
    };
  });

  // Chart props depend on active type
  const chartProps = useMemo((): ChartPriceMapping => {
    switch (executorType) {
      case "grid": return gridConfig.chartProps;
      case "position": return positionConfig.chartProps;
      case "order": return orderConfig.chartProps;
      case "iceberg": return orderConfig.chartProps;
      case "dca": return dcaConfig.chartProps;
      case "lp": return lpConfig.chartProps;
    }
  }, [executorType, gridConfig.chartProps, positionConfig.chartProps, orderConfig.chartProps, dcaConfig.chartProps, lpConfig.chartProps]);

  // Chart price set handler.
  //
  // Each per-type panel hands back a fresh config object every render, so naming
  // them as deps would rebuild this callback on every render and defeat the
  // stable identity the chart memoizes on. Pinning the deps to `[executorType]`
  // bought that stability with a stale closure -- the callback kept calling
  // whichever `handleChartPriceSet` existed when the type last changed, not the
  // current one. A latest-value ref gives the stability without the staleness.
  const priceSetTargets = useRef({ gridConfig, positionConfig, orderConfig, dcaConfig, lpConfig, pricePrecision });
  useEffect(() => {
    priceSetTargets.current = { gridConfig, positionConfig, orderConfig, dcaConfig, lpConfig, pricePrecision };
  });

  const handlePriceSet = useCallback(
    (field: PickSlot, price: number) => {
      const targets = priceSetTargets.current;
      switch (executorType) {
        case "grid":
          // The only arm that takes a third argument: the grid clamps the picked
          // price onto the venue's tick grid, and the precision is read off
          // trading rules queried for the market this very state holds.
          targets.gridConfig.handleChartPriceSet(field, price, targets.pricePrecision);
          break;
        case "position":
          targets.positionConfig.handleChartPriceSet(field, price);
          break;
        case "order":
        case "iceberg":
          targets.orderConfig.handleChartPriceSet(field, price);
          break;
        case "dca":
          targets.dcaConfig.handleChartPriceSet(field, price);
          break;
        case "lp":
          targets.lpConfig.handleChartPriceSet(field, price);
          break;
      }
    },
    [executorType],
  );

  const createLock = useRef(false);
  const leverageMutation = useMutation({
    mutationFn: () => {
      if (!server) throw new Error("No server");
      if (isPositionsError) throw new Error("Cannot read open positions, so leverage was not changed.");
      if (isLoadingPositions) throw new Error("Wait until the open position is loaded");
      if (openBook && openBook.leverage == null) {
        throw new Error("Cannot read the open leverage, so it was not changed.");
      }
      if (openLeverage != null && orderConfig.state.leverage === openLeverage) {
        throw new Error("That is already the open leverage.");
      }
      if (!(orderConfig.state.leverage >= 1)) throw new Error("Leverage must be at least 1");
      return api.setAccountLeverage(server, {
        leverage: orderConfig.state.leverage,
        connector_name: connector,
        trading_pair: pair,
        side: orderConfig.state.side,
      });
    },
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: () => {
      if (!server) throw new Error("No server");
      // Belt to the overlay's braces: the footer is covered on a view-only
      // venue, so this is unreachable from the UI — but the panel should not be
      // one stray caller away from posting a create it knows the venue will
      // reject for want of credentials.
      if (!caps.canTrade) throw new Error(`No API keys for ${connector}`);
      if (icebergCreateHeld(caps.rangeIcebergOmitsMargin, executorType, orderConfig.state.execution_strategy)) {
        throw new Error(ICEBERG_MARGIN_HOLD);
      }
      if (positionModeBlocksCreate(isSpot, executorType, positionModeQuery.isSuccess)) {
        throw new Error("Position mode has not been read, so the order was not sent.");
      }

      let payload: { executor_type: string; config: Record<string, unknown> };

      const mode = canonicalPositionMode(positionModeQuery.data?.position_mode ?? "");
      const positionsKnown = !isLoadingPositions && !isPositionsError;
      const book = {
        positionsKnown,
        sideHasPosition: sideHasOpenPosition(mode, hedgeBooks, openBook, orderConfig.state.side),
      };
      const cap = orderCap(
        mode,
        hedgeBooks,
        openBook,
        orderConfig.state.position_action,
        orderConfig.state.side,
      );
      switch (executorType) {
        case "grid":
          payload = gridConfig.buildPayload(connector, pair, isSpot);
          break;
        case "position": {
          payload = positionConfig.buildPayload(connector, pair, isSpot);
          payload.config.amount = legalBaseAmount(
            Number(payload.config.amount) || 0,
            pairRule,
          );
          const margin = marginForOpen({
            isSpot,
            opening: true,
            explicit: false,
            displayed: "ISOLATED",
            positionsKnown,
            sideHasPosition: sideHasOpenPosition(
              mode,
              hedgeBooks,
              openBook,
              positionConfig.state.side,
            ),
          });
          if ("block" in margin) throw new Error(margin.block);
          if (margin.send) {
            payload.config.margin_mode = margin.mode;
            payload.config.margin_explicit = true;
          }
          break;
        }
        case "order":
          payload = orderConfig.buildPayload(connector, pair, isSpot, false, cap, book);
          break;
        case "iceberg":
          payload = orderConfig.buildPayload(connector, pair, isSpot, true, cap, book);
          break;
        case "dca":
          payload = dcaConfig.buildPayload(connector, pair, isSpot);
          break;
        case "lp":
          // No isSpot: an LP position has no leverage, and connector is the network.
          payload = lpConfig.buildPayload(connector, pair);
          break;
      }

      if (executorType === "order" || executorType === "iceberg") {
        const closeError = isHedge(mode)
          ? applyHedge(
              payload.config,
              hedgeBooks,
              orderConfig.state.position_action,
              orderConfig.state.side,
            )
          : applyReducing(
              payload.config,
              openBook,
              orderConfig.state.position_action,
              mode,
            );
        if (closeError) throw new Error(closeError);
      }
      return api.createExecutor(server, payload);
    },
    onSuccess: (data) => {
      // Save defaults for the active type
      switch (executorType) {
        case "grid": gridConfig.save(); break;
        case "position": positionConfig.save(); break;
        case "order": orderConfig.save(); break;
        case "iceberg": orderConfig.save(); break;
        case "dca": dcaConfig.save(); break;
        case "lp": lpConfig.save(); break;
      }
      // Show success modal
      const notice =
        data.margin_mode_applied === false
          ? "The requested margin mode was not applied. The order uses the connector's current margin mode."
          : undefined;
      setSuccessInfo({ id: data.executor_id, type: executorType, connector, pair, notice });
      // Invalidate executor queries so the new one appears immediately
      queryClient.invalidateQueries({
        queryKey: executorsQuery(server, { controllerId: "main", pair }).queryKey,
      });
      queryClient.invalidateQueries({ queryKey: ["consolidated-positions", server] });
      // Auto-select the new executor in the bottom pane
      setSelectedExecutorId(data.executor_id);
    },
  });

  const icebergHeld = icebergCreateHeld(
    caps.rangeIcebergOmitsMargin,
    executorType,
    orderConfig.state.execution_strategy,
  );
  const modeUnread = positionModeBlocksCreate(isSpot, executorType, positionModeQuery.isSuccess);
  const shownMode = canonicalPositionMode(positionModeQuery.data?.position_mode ?? "");
  const marginDecision = marginForOpen({
    isSpot,
    opening:
      executorType === "position" ||
      ((executorType === "order" || executorType === "iceberg") &&
        orderConfig.state.position_action !== "CLOSE"),
    explicit: executorType === "position" ? false : orderConfig.state.marginExplicit,
    displayed: executorType === "position" ? "ISOLATED" : orderConfig.state.ri_margin_mode,
    positionsKnown: !isLoadingPositions && !isPositionsError,
    sideHasPosition: sideHasOpenPosition(
      shownMode,
      hedgeBooks,
      openBook,
      executorType === "position" ? positionConfig.state.side : orderConfig.state.side,
    ),
  });
  const marginBlocked = "block" in marginDecision;

  if (!server) {
    return <NoServerCard message="Select a server from the sidebar to create an executor." />;
  }

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col">
      {/* Top Bar */}
      <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 border-r border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>

        {/* The market: one chip, one door.
            Pair and venue used to be two dropdowns beside a Browse button —
            three controls answering one question, and the venue one committed
            on its own, dropping the page onto the new venue's default pair
            before you had chosen one. The chip states the market and opens the
            browser, which is where both halves are now chosen together. */}
        <div className="relative flex items-center border-r border-[var(--color-border)]">
          <button
            onClick={() => setBrowserOpen((v) => !v)}
            aria-pressed={browserOpen}
            aria-expanded={browserOpen}
            aria-haspopup="dialog"
            {...browseHint.hoverProps}
            // The hint owns the hover while it is pending, so the browser's own
            // tooltip does not come up underneath it saying the same thing.
            title={
              browseHint.pending
                ? undefined
                : browserOpen
                  ? "Close market list (Esc)"
                  : "Change market (/)"
            }
            className={`flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${
              browserOpen
                ? "bg-[var(--color-surface-hover)]"
                : "hover:bg-[var(--color-surface-hover)]"
            }`}
          >
            {/* The venue qualifies the pair, and reads first here so the chip
                agrees with the browser it opens: venue rail first, pair table
                after. The pair is still the identity of everything on this
                page, so it keeps the body colour. */}
            <span className="text-xs text-[var(--color-text-muted)]">
              {formatConnectorName(connector)}
            </span>
            <span className="text-base font-semibold text-[var(--color-text)]">{pair}</span>
            {/* A chevron, not a list glyph: the caret is the web's word for
                "this opens", and it points at the panel that drops below. It
                flips while the browser is open, so the chip also says how to
                close it. */}
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                browserOpen
                  ? "rotate-180 text-[var(--color-primary)]"
                  : "text-[var(--color-text-muted)]"
              }`}
            />
          </button>
          {/* Star the pair in the header, without a round trip through Browse.
              Reads as a mark on the pair name, so it trails it. */}
          <StarMarketButton server={server} connector={connector} pair={pair} />
          {/* The shortcut, in words, on the first hover only. Suppressed while
              the list is open, where the key it teaches would do nothing. */}
          {browseHint.visible && !browserOpen && (
            <HintBubble>
              Tip: press{" "}
              <kbd className="rounded border border-[var(--color-border)] px-1 font-mono text-[10px] leading-4">
                /
              </kbd>{" "}
              to browse markets.
            </HintBubble>
          )}
        </div>

        {/* Price ticker */}
        <div className="flex flex-1 items-center px-4 py-2">
          <PriceTicker
            server={server}
            connector={connector}
            pair={pair}
            hasRestPrice={caps.hasRestPrice}
            showStats={caps.hasOrderBook}
          />
        </div>

        {/* Interval + Range */}
        <div className="flex items-center gap-3 border-l border-[var(--color-border)] px-4 py-2">
          <div className="flex overflow-hidden rounded-md border border-[var(--color-border)]">
            {INTERVALS.map((iv) => (
              <button
                key={iv}
                onClick={() => gridDispatch({ type: "SET_FIELD", field: "interval", value: iv })}
                className={`px-2.5 py-1 text-xs ${
                  gridState.interval === iv
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
                }`}
              >
                {iv}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--color-text-muted)]">Range:</span>
            <div className="flex overflow-hidden rounded-md border border-[var(--color-border)]">
              {LOOKBACK_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => gridDispatch({ type: "SET_FIELD", field: "lookbackSeconds", value: opt.seconds })}
                  className={`px-2 py-1 text-xs ${
                    gridState.lookbackSeconds === opt.seconds
                      ? "bg-[var(--color-primary)] text-white"
                      : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* This server's starred markets — one click to the chart, no overlay. */}
      {caps.hasOrderBook && !browserOpen && (
        <FavoritesStrip
          server={server}
          connector={connector}
          pair={pair}
          onPick={applyMarket}
        />
      )}

      {/* Main Area: Chart + Right Panel */}
      <div className="flex min-h-0 flex-1">
        {/* Chart + Bottom Pane */}
        <div className="relative min-w-0 flex-1 flex flex-col">
          {browserOpen && caps.hasOrderBook && (
            <MarketBrowser
              server={server}
              connector={connector}
              pair={pair}
              connectors={allConnectors}
              credentialed={credentialedConnectors}
              onPick={applyMarket}
              onClose={() => setBrowserOpen(false)}
            />
          )}
          <div className="flex-1 min-h-0 overflow-hidden bg-[var(--color-surface)]">
            <TradeChart
              key={`${connector}:${pair}:${gridState.interval}`}
              server={server}
              connector={connector}
              pair={pair}
              interval={gridState.interval}
              lookbackSeconds={gridState.lookbackSeconds}

              startPrice={chartProps.startPrice}
              endPrice={chartProps.endPrice}
              limitPrice={chartProps.limitPrice}
              side={chartProps.side}
              minSpread={chartProps.minSpread}
              activePickField={chartProps.activePickField}
              lineLabels={chartProps.lineLabels}
              onPriceSet={handlePriceSet}
              pricePrecision={pricePrecision}
              extraLines={chartProps.extraLines}
              executorOverlays={mainOverlays}
              positions={mainPositions}
              selectedExecutorId={selectedExecutorId}
              onExecutorDeselect={() => setSelectedExecutorId(null)}
            />
          </div>
          {/* Horizontal resize handle */}
          <div
            className="group/hdrag relative h-1.5 shrink-0 cursor-row-resize border-y border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-primary)]/10 active:bg-[var(--color-primary)]/20 transition-colors"
            onMouseDown={startVDrag}
          >
            <div className="absolute inset-x-0 top-1/2 mx-auto h-px w-12 -translate-y-1/2 rounded bg-amber-400/60 group-hover/hdrag:bg-amber-400 transition-colors" />
          </div>
          <div style={{ height: bottomPaneHeight }} className="shrink-0 overflow-hidden">
            <TradeBottomPane
              executors={mainExecutors}
              positions={mainPositions}
              isLoadingPositions={isLoadingPositions}
              connector={connector}
              pair={pair}
              isSpot={isSpot}
              showOrders={caps.hasOrderBook}
              selectedExecutorId={selectedExecutorId}
              onExecutorSelect={(ex) => {
                setSelectedExecutorId(ex?.id ?? null);
                // If this executor is older than current candle range, expand lookback
                if (ex && ex.timestamp > 0) {
                  const key = `candles:${server}:${connector}:${pair}:${gridState.interval}`;
                  const candles = candleStore.getCandles(key);
                  if (candles.length > 0) {
                    const minTime = candles[0].timestamp;
                    if (ex.timestamp < minTime) {
                      handleRequestCandleRange(ex.timestamp);
                    }
                  }
                }
              }}
            />
          </div>
        </div>

        {/* Vertical resize handle */}
        <div
          className="group/vdrag relative w-1.5 shrink-0 cursor-col-resize border-x border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-primary)]/10 active:bg-[var(--color-primary)]/20 transition-colors"
          onMouseDown={startHDrag}
        >
          <div className="absolute inset-y-0 left-1/2 my-auto h-12 w-px -translate-x-1/2 rounded bg-amber-400/60 group-hover/vdrag:bg-amber-400 transition-colors" />
        </div>

        {/* Right Panel */}
        <div className="flex shrink-0 flex-col bg-[var(--color-surface)]" style={{ width: rightPanelWidth }}>
          {/* Panel Mode Toggle */}
          <div className="flex border-b border-[var(--color-border)]">
            <button
              onClick={() => setRightPanel("config")}
              className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium transition-colors ${
                activePanel === "config"
                  ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
              }`}
            >
              <Settings2 className="h-3.5 w-3.5" />
              Execute
            </button>
            {caps.hasOrderBook && (
            <button
              onClick={() => setRightPanel("depth")}
              className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium transition-colors ${
                activePanel === "depth"
                  ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
              }`}
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Data
            </button>
            )}
          </div>

          {activePanel === "config" ? (
            <>
              <ExecutorTypeSelect
                options={TYPE_TABS.filter((tab) => caps.executorTypes.includes(tab.value))}
                value={executorType}
                onChange={handleTypeChange}
              />

              {/* Everything the venue's credentials gate, the config form and
                  the Create button, sits inside this one positioned box, so
                  the view-only overlay covers exactly that and nothing else:
                  the type selector above it still switches, the Data tab beside it
                  is untouched, and the panel keeps its scroll/footer split. */}
              <div className="relative flex min-h-0 flex-1 flex-col">
                {/* Config Panel */}
                <div className="flex-1 overflow-y-auto">
                  {executorType === "grid" && (
                    <GridConfigPanel state={gridState} dispatch={gridDispatch} currentPrice={currentPrice} isSpot={isSpot} quoteCurrency={pair?.split("-")[1] || "USDT"} />
                  )}
                  {executorType === "position" && (
                    <PositionConfigPanel state={positionConfig.state} dispatch={positionConfig.dispatch} validation={positionConfig.validation} currentPrice={currentPrice} isSpot={isSpot} pair={pair} sizeRule={pairRule} />
                  )}
                  {executorType === "order" && (
                    <OrderConfigPanel state={orderConfig.state} dispatch={orderConfig.dispatch} validation={orderConfig.validation} currentPrice={currentPrice} isSpot={isSpot} pair={pair} connector={connector} strategies={orderStrategies} marginModes={caps.marginModes} sizeRule={pairRule} positionLeverage={openLeverage} openBook={openBook} positionMode={canonicalPositionMode(positionModeQuery.data?.position_mode ?? "")} onApplyLeverage={() => leverageMutation.mutate()} applyingLeverage={leverageMutation.isPending} positionsLoaded={!isLoadingPositions} positionsFailed={isPositionsError} onStrategyHold={setStrategyHold} baseAvailable={balances.base} quoteAvailable={balances.quote} books={hedgeBooks} />
                  )}
                  {executorType === "iceberg" && (
                    <OrderConfigPanel state={orderConfig.state} dispatch={orderConfig.dispatch} validation={orderConfig.validation} currentPrice={currentPrice} isSpot={isSpot} pair={pair} connector={connector} strategies={orderStrategies} marginModes={caps.marginModes} sizeRule={pairRule} lockStrategy positionLeverage={openLeverage} openBook={openBook} positionMode={canonicalPositionMode(positionModeQuery.data?.position_mode ?? "")} onApplyLeverage={() => leverageMutation.mutate()} applyingLeverage={leverageMutation.isPending} positionsLoaded={!isLoadingPositions} positionsFailed={isPositionsError} baseAvailable={balances.base} quoteAvailable={balances.quote} books={hedgeBooks} />
                  )}
                  {executorType === "dca" && (
                    <DCAConfigPanel state={dcaConfig.state} dispatch={dcaConfig.dispatch} validation={dcaConfig.validation} currentPrice={currentPrice} isSpot={isSpot} pair={pair} />
                  )}
                  {executorType === "lp" && (
                    <LPConfigPanel state={lpConfig.state} dispatch={lpConfig.dispatch} validation={lpConfig.validation} currentPrice={currentPrice} pair={pair} pool={lpConfig.pool} poolFetching={lpConfig.poolFetching} baseAvailable={balances.base} quoteAvailable={balances.quote} />
                  )}
                </div>

                {/* Sticky Create Footer */}
                <div className="border-t border-[var(--color-border)] p-3">
                  {!activeValidation.valid && (
                    <p className="mb-2 text-[11px] text-[var(--color-red)]">
                      {activeValidation.errors[0]}
                    </p>
                  )}
                  {icebergHeld && (
                    <p className="mb-2 text-[11px] text-[var(--color-red)]">{ICEBERG_MARGIN_HOLD}</p>
                  )}
                  {modeUnread && (
                    <p className="mb-2 text-[11px] text-[var(--color-red)]">
                      Position mode has not been read, so this order was not sent.
                    </p>
                  )}
                  {marginBlocked && (
                    <p className="mb-2 text-[11px] text-[var(--color-red)]">{MARGIN_CHOOSE}</p>
                  )}
                  <button
                    onClick={() => {
                      if (!claimInflight(createLock)) return;
                      createMutation.mutate(undefined, {
                        onSettled: () => {
                          createLock.current = false;
                        },
                      });
                    }}
                    disabled={!caps.canTrade || !activeValidation.valid || createMutation.isPending || ordersBlockCreate(executorType, caps.hasOrderBook, ordersHealth.isError) || strategyHold || icebergHeld || modeUnread || marginBlocked || (executorType === "order" && !orderStrategies.includes(orderConfig.state.execution_strategy))}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-sm font-bold text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Rocket className="h-4 w-4" />
                    )}
                    {executorType === "iceberg" || orderConfig.state.execution_strategy === "RANGE_ICEBERG"
                      ? "Create Range Iceberg"
                      : `Create ${TYPE_LABELS[executorType]}`}
                  </button>
                </div>

                {!caps.canTrade && <ViewOnlyOverlay connector={connector} />}
              </div>
            </>
          ) : (
            <MarketDepthPanel server={server} connector={connector} pair={pair} />
          )}
        </div>
      </div>

      {/* Success modal */}
      {successInfo && (
        <ExecutorSuccessModal
          executorId={successInfo.id}
          title={
            successInfo.type === "order" && orderConfig.state.execution_strategy === "RANGE_ICEBERG"
              ? "Range Iceberg Created"
              : `${TYPE_LABELS[successInfo.type]} Created`
          }
          subtitle={
            successInfo.notice ??
            `Successfully deployed on ${successInfo.connector}`
          }
          details={
            <>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[var(--color-text-muted)]">Pair</span>
                <span className="font-mono text-[var(--color-text)]">{successInfo.pair}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[var(--color-text-muted)]">Status</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-green)]/15 px-1.5 py-0.5 text-[9px] font-bold text-[var(--color-green)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-green)] animate-pulse" />
                  ACTIVE
                </span>
              </div>
            </>
          }
          primaryLabel="Continue Trading"
          onClose={() => setSuccessInfo(null)}
        />
      )}

      {/* Error toast */}
      {createMutation.isError && (
        <ErrorToast message={(createMutation.error as Error).message} />
      )}
    </div>
  );
}
