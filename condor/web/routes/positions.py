from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends

from condor.fetchers.market_data import fetch_current_price
from condor.server_data_service import ServerDataType, get_server_data_service
from condor.web.auth import require_server_access
from condor.web.models import WebUser
from config_manager import get_config_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["positions"])


def _first_number(*values: object, default: float = 0.0) -> float:
    """The first value that parses as a float.

    Exchange rows send numbers as strings and as Decimals. ``or`` would also
    treat a real zero as missing, so absence is only ``None`` and ``""``.
    """
    for value in values:
        if value is None or value == "":
            continue
        try:
            return float(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
    return default


def _side_label(raw: object) -> str:
    """``LONG`` out of ``LONG``, ``PositionSide.LONG`` or ``TradeType.BUY``."""
    text = str(raw or "").strip()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text.upper()


def _market_pair(raw: object) -> str:
    """Hummingbot spells the pair ``AIOT-USDT``. MEXC's own symbol is ``AIOT_USDT``."""
    return str(raw or "").strip().replace("_", "-")


def _side_key(side: str) -> str:
    """Fold BUY/LONG and SELL/SHORT so a venue row does not double a tracked one."""
    text = _side_label(side)
    if text in ("LONG", "BUY"):
        return "LONG"
    if text in ("SHORT", "SELL"):
        return "SHORT"
    return text


def merge_venue_positions(tracked: list[dict], venue: list[dict]) -> list[dict]:
    """Venue rows the trade page should show on top of executor-tracked ones.

    ``/trading/positions`` is the exchange's own book. A MEXC position opened
    outside an executor never appears in ``get_positions_summary``, so the
    bottom pane used to say the account was flat. A row the summary already
    carries for the same connector, pair and side is left out, so one position
    is not drawn twice. A zero amount is flat and is left out too.
    """
    held = set()
    for row in tracked:
        # A flat executor row (amount 0) is not the position. Treating it as
        # held hid the exchange's own long, which is the row the trade page
        # was missing. A row with no amount is still a key: the summary named
        # that side, so the venue copy would be a second drawing of it.
        amount = row.get("amount")
        if amount is not None and amount != "" and _first_number(amount) == 0:
            continue
        held.add(
            (
                str(row.get("connector_name") or ""),
                _market_pair(row.get("trading_pair")).upper(),
                _side_key(str(row.get("position_side") or "")),
            )
        )
    extra: list[dict] = []
    for raw in venue:
        if not isinstance(raw, dict):
            continue
        amount = _first_number(raw.get("net_amount_base"), raw.get("amount"))
        if amount == 0:
            continue
        row = _normalize_position(raw, "venue", "Exchange")
        key = (
            row["connector_name"],
            _market_pair(row["trading_pair"]).upper(),
            _side_key(str(row["position_side"])),
        )
        if key in held:
            continue
        held.add(key)
        extra.append(row)
    return extra


def _normalize_position(pos: dict, source: str, source_name: str) -> dict:
    """Normalize a position dict to a common shape with source info."""
    amount = _first_number(pos.get("net_amount_base"), pos.get("amount"))
    entry_price = _first_number(pos.get("buy_breakeven_price"), pos.get("entry_price"))
    try:
        notional_value = abs(float(amount)) * float(entry_price)
    except (ValueError, TypeError):
        notional_value = 0
    # Which executors this row aggregates. The only attribution the API gives a
    # held position: a position has no pool of its own, but an LP executor
    # records the pool it opened in, so the pool workspace can tell a hold that
    # belongs to the pool on screen from one held in another pool of the same
    # pair on the same chain.
    executor_ids = pos.get("executor_ids") or []
    if not isinstance(executor_ids, list):
        executor_ids = []
    return {
        "connector_name": pos.get("connector_name") or pos.get("connector") or "",
        "trading_pair": _market_pair(pos.get("trading_pair") or pos.get("symbol")),
        "position_side": _side_label(pos.get("position_side") or pos.get("side")),
        "amount": amount,
        "entry_price": entry_price,
        "notional_value": notional_value,
        "current_price": pos.get("current_price") or 0,
        "unrealized_pnl": _first_number(
            pos.get("unrealized_pnl_quote"), pos.get("unrealized_pnl")
        ),
        "leverage": _first_number(pos.get("leverage"), default=1.0),
        "controller_id": pos.get("controller_id") or "",
        "realized_pnl": pos.get("realized_pnl_quote") or 0,
        "cum_fees": pos.get("cum_fees_quote") or 0,
        "executor_count": pos.get("executor_count") or 0,
        "executor_ids": [str(i) for i in executor_ids],
        "source": source,
        "source_name": source_name,
    }


@router.get("/servers/{name}/positions")
async def get_consolidated_positions(
    name: str,
    user: WebUser = Depends(require_server_access),
):
    cm = get_config_manager()

    # Fetch executor positions and bot data in parallel
    async def fetch_executor_positions():
        try:
            client = await cm.get_client(name)
            result = await client.executors.get_positions_summary()
            if isinstance(result, dict):
                positions = result.get("positions", [])
                if not isinstance(positions, list):
                    positions = [positions] if positions else []
            elif isinstance(result, list):
                positions = result
            else:
                positions = []
            return positions
        except Exception as e:
            logger.warning("Failed to fetch executor positions from '%s': %s", name, e)
            return []

    async def fetch_bot_positions():
        try:
            result = await get_server_data_service().get_or_fetch(
                name, ServerDataType.BOTS_STATUS
            )
            if result is None:
                return []

            positions = []
            bots_list = []
            if isinstance(result, dict):
                data = result.get("data", {})
                if isinstance(data, dict):
                    bots_list = [
                        {"bot_name": k, **v}
                        for k, v in data.items()
                        if isinstance(v, dict)
                    ]
                elif isinstance(data, list):
                    bots_list = [b for b in data if isinstance(b, dict)]
            elif isinstance(result, list):
                bots_list = [b for b in result if isinstance(b, dict)]

            for bot_data in bots_list:
                bot_name = bot_data.get("bot_name", "")
                performance = bot_data.get("performance", {})
                if not isinstance(performance, dict):
                    continue
                for ctrl_name, ctrl_info in performance.items():
                    if not isinstance(ctrl_info, dict):
                        continue
                    ctrl_perf = ctrl_info.get("performance", {})
                    if not isinstance(ctrl_perf, dict):
                        continue
                    pos_summary = ctrl_perf.get("positions_summary", [])
                    if not isinstance(pos_summary, list):
                        continue
                    for pos in pos_summary:
                        if isinstance(pos, dict):
                            positions.append((pos, f"{bot_name}/{ctrl_name}"))
            return positions
        except Exception as e:
            logger.warning("Failed to fetch bot positions from '%s': %s", name, e)
            return []

    async def fetch_venue_positions():
        # The exchange book, not the executor ledger. A position MEXC already
        # holds is invisible to get_positions_summary until an executor adopts
        # it, and the trade page was reporting the account flat.
        try:
            from condor.fetchers.positions import fetch_positions

            client = await cm.get_client(name)
            return await fetch_positions(client, strict=True)
        except Exception as e:
            logger.warning("Failed to fetch venue positions from '%s': %s", name, e)
            return []

    exec_raw, bot_raw, venue_raw = await asyncio.gather(
        fetch_executor_positions(),
        fetch_bot_positions(),
        fetch_venue_positions(),
    )

    executor_positions = [
        _normalize_position(pos, "executor", "Executor")
        for pos in exec_raw
        if isinstance(pos, dict)
    ]

    bot_positions = [
        _normalize_position(pos, "bot", source_name) for pos, source_name in bot_raw
    ]
    venue_positions = merge_venue_positions(
        executor_positions + bot_positions, venue_raw
    )

    # Enrich positions missing current_price (the positions_summary endpoint doesn't provide it)
    all_positions = executor_positions + bot_positions + venue_positions
    pairs_needing_price = {}
    for pos in all_positions:
        if pos["current_price"] == 0 and pos["connector_name"] and pos["trading_pair"]:
            key = (pos["connector_name"], pos["trading_pair"])
            pairs_needing_price[key] = None

    if pairs_needing_price:
        try:
            client = await cm.get_client(name)
            price_tasks = [
                fetch_current_price(client, conn, pair)
                for conn, pair in pairs_needing_price
            ]
            results = await asyncio.gather(*price_tasks, return_exceptions=True)
            for (conn, pair), price in zip(pairs_needing_price, results):
                if isinstance(price, (int, float)) and price:
                    pairs_needing_price[(conn, pair)] = float(price)

            for pos in all_positions:
                if pos["current_price"] == 0:
                    key = (pos["connector_name"], pos["trading_pair"])
                    price = pairs_needing_price.get(key)
                    if price:
                        pos["current_price"] = price
        except Exception as e:
            logger.warning("Failed to enrich positions with current prices: %s", e)

    return {
        "executor_positions": executor_positions,
        "bot_positions": bot_positions,
        "venue_positions": venue_positions,
    }
