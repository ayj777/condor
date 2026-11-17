/**
 * Close, stop, and position-row rules the trade page and the API agree on.
 */

export interface OpenBook {
  amount: number;
  side: "LONG" | "SHORT" | "";
  leverage: number | null;
  marginMode: string | null;
}

export interface PositionRow {
  source?: string;
  connector?: string;
  trading_pair?: string;
  side?: string;
  position_side?: string;
  amount?: number | string;
  leverage?: number | null;
  margin_mode?: string | null;
}

export const ICEBERG_MARGIN_HOLD =
  "Range iceberg stays off until the executor can leave margin unchanged. The current executor would set isolated margin on the open position.";

/** True while the deployed executor would fill in isolated margin. */
export function icebergCreateHeld(
  omitsMargin: boolean,
  executorType: string,
  strategy: string,
): boolean {
  const iceberg = executorType === "iceberg" || strategy === "RANGE_ICEBERG";
  return iceberg && !omitsMargin;
}

export const MARGIN_CHOOSE =
  "Choose a margin mode: no open position on this side";

/**
 * Whether this order needs a margin mode on the payload.
 *
 * A side with no open position must send the mode the form is showing.
 * Isolated is that default. An open position is left alone unless the user
 * edited the mode. An unread book blocks the submit.
 */
export function marginForOpen(input: {
  isSpot: boolean;
  opening: boolean;
  explicit: boolean;
  displayed?: string | null;
  positionsKnown: boolean;
  sideHasPosition: boolean | null;
}): { send: false } | { send: true; mode: string } | { block: typeof MARGIN_CHOOSE } {
  const displayed = String(input.displayed || "ISOLATED").toUpperCase();
  if (input.isSpot || !input.opening) {
    if (input.explicit) return { send: true, mode: displayed };
    return { send: false };
  }
  if (input.explicit) return { send: true, mode: displayed };
  if (!input.positionsKnown || input.sideHasPosition == null) return { block: MARGIN_CHOOSE };
  if (!input.sideHasPosition) return { send: true, mode: displayed };
  return { send: false };
}

/** Hedge looks at the chosen side. One-way looks at the single book. Unknown mode returns null. */
export function sideHasOpenPosition(
  mode: string,
  books: HedgeBooks,
  fallback: OpenBook | null,
  side: unknown,
): boolean | null {
  if (isHedge(mode)) {
    const book = isLongSide(side) ? books.long : books.short;
    return !!book && book.amount > 0;
  }
  if (isOneWay(mode)) return !!fallback && fallback.amount > 0;
  return null;
}

/** A perp order or iceberg waits until the position-mode read has succeeded. */
export function positionModeBlocksCreate(
  isSpot: boolean,
  executorType: string,
  loaded: boolean,
): boolean {
  if (isSpot || loaded) return false;
  return executorType === "order" || executorType === "iceberg";
}

/** MEXC positionMode 1 is hedge and 2 is one-way. Names are read as spelled. */
export function canonicalPositionMode(value: unknown): "" | "HEDGE" | "ONEWAY" {
  if (value === 1 || value === "1") return "HEDGE";
  if (value === 2 || value === "2") return "ONEWAY";
  const text = String(value ?? "").trim();
  const name = text.includes(".") ? text.slice(text.lastIndexOf(".") + 1) : text;
  const collapsed = name.replace(/[-_\s]/g, "").toUpperCase();
  if (collapsed === "HEDGE") return "HEDGE";
  if (collapsed === "ONEWAY") return "ONEWAY";
  return "";
}

export function isHedge(mode: string): boolean {
  return canonicalPositionMode(mode) === "HEDGE";
}

export function isOneWay(mode: string): boolean {
  return canonicalPositionMode(mode) === "ONEWAY";
}

export function isLongSide(side: unknown): boolean {
  const text = String(side ?? "").toUpperCase();
  return text === "1" || text === "BUY" || text === "LONG";
}

export interface HedgeBooks {
  long: OpenBook | null;
  short: OpenBook | null;
}

/** Hedge close uses the side the user chose. Anything else uses the single book. */
export function bookForOrder(
  mode: string,
  books: HedgeBooks,
  fallback: OpenBook | null,
  side: unknown,
): OpenBook | null {
  if (!isHedge(mode)) return fallback;
  return isLongSide(side) ? books.long : books.short;
}

export function orderCap(
  mode: string,
  books: HedgeBooks,
  fallback: OpenBook | null,
  action: string,
  side: unknown,
): number {
  if (isHedge(mode)) {
    if (action !== "CLOSE") return 0;
    const book = bookForOrder(mode, books, fallback, side);
    return book && book.amount > 0 ? book.amount : 0;
  }
  return reducingCap(fallback, action, side, mode);
}

/** A one-way sell against a long, or a buy against a short, reduces that book. */
export function reducesOpen(side: unknown, book: OpenBook | null, mode: string): boolean {
  if (!isOneWay(mode) || !book || !(book.amount > 0)) return false;
  const text = String(side ?? "").toUpperCase();
  const selling = text === "2" || text === "SELL" || text === "SHORT";
  const buying = text === "1" || text === "BUY" || text === "LONG";
  if (book.side === "LONG" && selling) return true;
  if (book.side === "SHORT" && buying) return true;
  return false;
}

/** Base cap for a close or a one-way reducing order. Zero means no cap. */
export function reducingCap(
  book: OpenBook | null,
  action: string,
  side: unknown,
  mode: string,
): number {
  if (!book || !(book.amount > 0)) return 0;
  if (action === "CLOSE" || reducesOpen(side, book, mode)) return book.amount;
  return 0;
}

/**
 * Hedge open and close.
 *
 * Open short is its own position: not reduce-only, not capped by the long.
 * Close long is explicit: reduce_only, position_side LONG, and never more
 * than that long. Close short is the same on the short.
 */
export function applyHedge(
  config: Record<string, unknown>,
  books: HedgeBooks,
  action: string,
  side: unknown,
): string | null {
  const wantLong = isLongSide(side);
  const positionSide = wantLong ? "LONG" : "SHORT";
  config.position_side = positionSide;
  if (action !== "CLOSE") {
    config.position_action = "OPEN";
    config.reduce_only = false;
    return null;
  }
  const book = wantLong ? books.long : books.short;
  if (!book || !(book.amount > 0)) {
    return wantLong ? "No open long to close" : "No open short to close";
  }
  config.position_action = "CLOSE";
  config.reduce_only = true;
  const trade = String(config.side ?? "").toUpperCase();
  const word = trade === "BUY" || trade === "SELL";
  config.side = word ? (wantLong ? "SELL" : "BUY") : wantLong ? 2 : 1;
  for (const key of ["amount", "total_amount"] as const) {
    const value = config[key];
    if (typeof value === "number" && value > book.amount) config[key] = book.amount;
  }
  return null;
}

/** Close, or a one-way order that reduces the open book, is reduce-only and capped. */
export function applyReducing(
  config: Record<string, unknown>,
  book: OpenBook | null,
  action: string,
  mode: string,
): string | null {
  if (action === "CLOSE") return applyClose(config, book, action);
  if (!reducesOpen(config.side, book, mode) || !book) return null;
  config.reduce_only = true;
  for (const key of ["amount", "total_amount"] as const) {
    if (key === "total_amount" && config.size_unit === "QUOTE") continue;
    const value = config[key];
    if (typeof value === "number" && value > book.amount) config[key] = book.amount;
  }
  return null;
}

export function resultingSize(open: number, order: number, reducing: boolean): number {
  const next = reducing ? Math.max(0, open - order) : open + order;
  return Number(next.toPrecision(12));
}

/** Close sends a reduce-only order, and never more than the open amount. */
export function applyClose(
  config: Record<string, unknown>,
  book: OpenBook | null,
  action: string,
): string | null {
  if (action !== "CLOSE") return null;
  if (!book || !(book.amount > 0)) return "No open position to close";
  const reducing = book.side === "SHORT" ? "BUY" : "SELL";
  const numeric = reducing === "BUY" ? 1 : 2;
  const side = config.side;
  config.side = side === "BUY" || side === "SELL" ? reducing : numeric;
  config.position_action = "CLOSE";
  config.reduce_only = true;
  for (const key of ["amount", "total_amount"] as const) {
    const value = config[key];
    if (typeof value === "number" && value > book.amount) config[key] = book.amount;
  }
  return null;
}

export function positionModeLabel(mode: unknown): string {
  const name = canonicalPositionMode(mode);
  if (name === "ONEWAY") return "One-way";
  if (name === "HEDGE") return "Hedge";
  return "";
}

/** On one-way, a sell against a long reduces it. Hedge names each open and close. */
export function sideOptions(
  mode: string,
  book: OpenBook | null,
  action = "OPEN",
): { value: string; label: string }[] {
  if (isHedge(mode)) {
    if (action === "CLOSE") {
      return [
        { value: "LONG", label: "Close long" },
        { value: "SHORT", label: "Close short" },
      ];
    }
    return [
      { value: "LONG", label: "Open long" },
      { value: "SHORT", label: "Open short" },
    ];
  }
  const oneWay = isOneWay(mode);
  if (!oneWay) {
    return [
      { value: "LONG", label: "Long" },
      { value: "SHORT", label: "Short" },
    ];
  }
  const longOpen = book?.side === "LONG" && (book.amount ?? 0) > 0;
  return [
    { value: "LONG", label: "Buy" },
    { value: "SHORT", label: longOpen ? "Sell (reduces the long)" : "Sell" },
  ];
}

/**
 * The pane always shows the exchange row. A tracked row is shown beside it
 * only when the amounts differ, and the exchange row is named as such.
 */
export function rowsForPane<T extends PositionRow>(tracked: T[], venue: T[]): T[] {
  const out: T[] = [];
  const used = new Set<number>();
  for (const row of venue) {
    const amount = Number(row.amount);
    if (!(Math.abs(amount) > 0)) continue;
    out.push({ ...row, source: "venue" });
    const twin = tracked.findIndex((item, index) => {
      if (used.has(index)) return false;
      return sameBook(item, row);
    });
    if (twin >= 0) {
      used.add(twin);
      const trackedAmount = Number(tracked[twin].amount);
      if (Number.isFinite(trackedAmount) && Math.abs(trackedAmount - Math.abs(amount)) > 1e-6) {
        out.push({ ...tracked[twin], source: tracked[twin].source || "executor" });
      }
    }
  }
  tracked.forEach((row, index) => {
    if (used.has(index)) return;
    if (!(Math.abs(Number(row.amount)) > 0)) return;
    out.push(row);
  });
  return out;
}

function sameBook(a: PositionRow, b: PositionRow): boolean {
  const pair = (value: string | undefined) => (value || "").replace(/_/g, "-").toUpperCase();
  const side = (value: string | undefined) => {
    const name = (value || "").toUpperCase();
    if (name === "BUY" || name === "LONG" || name === "1") return "LONG";
    if (name === "SELL" || name === "SHORT" || name === "2") return "SHORT";
    return name;
  };
  return (
    (a.connector || "").toLowerCase() === (b.connector || "").toLowerCase() &&
    pair(a.trading_pair) === pair(b.trading_pair) &&
    side(a.position_side || a.side) === side(b.position_side || b.side)
  );
}

/** A failed open-order read blocks only an order or iceberg on a book venue. */
export function ordersBlockCreate(
  executorType: string,
  hasOrderBook: boolean,
  failed: boolean,
): boolean {
  if (!failed || !hasOrderBook) return false;
  return executorType === "order" || executorType === "iceberg";
}

/** The first click claims the lock. A second click in the same turn does not. */
export function claimInflight(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

/** The position side an executor filled. Empty when the row does not say. */
export function executorBookSide(ex: {
  side?: string;
  position_side?: string;
  position_action?: string;
  config?: Record<string, unknown>;
} | null | undefined): "LONG" | "SHORT" | "" {
  if (!ex) return "";
  const config = ex.config ?? {};
  const named = canonicalSide(config.position_side ?? ex.position_side);
  if (named) return named;
  const action = String(config.position_action ?? ex.position_action ?? "OPEN").toUpperCase();
  const trade = canonicalSide(config.side ?? ex.side);
  if (action.endsWith("CLOSE")) {
    if (trade === "SHORT") return "LONG";
    if (trade === "LONG") return "SHORT";
    return "";
  }
  return trade;
}

function canonicalSide(raw: unknown): "LONG" | "SHORT" | "" {
  const text = String(raw ?? "").toUpperCase();
  const name = text.includes(".") ? text.slice(text.lastIndexOf(".") + 1) : text;
  if (name === "LONG" || name === "BUY" || name === "1") return "LONG";
  if (name === "SHORT" || name === "SELL" || name === "2") return "SHORT";
  return "";
}

/** The stop dialog keeps the position when the venue already has one. */
export function defaultKeepPosition(venueAmount: number): boolean {
  return venueAmount > 0;
}
