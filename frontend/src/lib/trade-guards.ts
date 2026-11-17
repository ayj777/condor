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

export function isOneWay(mode: string): boolean {
  const name = mode.toUpperCase();
  return name === "ONEWAY" || name === "ONE_WAY";
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

export function positionModeLabel(mode: string): string {
  const name = mode.toUpperCase();
  if (name === "ONEWAY" || name === "ONE_WAY") return "One-way";
  if (name === "HEDGE") return "Hedge";
  return "";
}

/** On one-way, a sell against a long reduces it. The label says so. */
export function sideOptions(mode: string, book: OpenBook | null): { value: string; label: string }[] {
  const oneWay = mode.toUpperCase() === "ONEWAY" || mode.toUpperCase() === "ONE_WAY";
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

/** The stop dialog keeps the position when the venue already has one. */
export function defaultKeepPosition(venueAmount: number): boolean {
  return venueAmount > 0;
}
