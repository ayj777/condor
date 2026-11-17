"""Apply leverage and margin mode before an executor is created.

``OrderExecutorConfig`` records leverage for the balance check and does not
send it on the order. MEXC reads leverage from the account and reads margin
mode from ``openType`` on each order, which the connector takes from the mode
it was last told. Range iceberg calls ``confirm_leverage_and_margin`` itself.
A limit or market order does not, so Condor sets them here for venues whose
profile says the account has to be confirmed first.

The stock Hummingbot API exposes ``set_leverage`` and does not expose a
margin-mode route. A missing route is not a failed order: the executor config
still carries the mode, and range iceberg applies it. A leverage rejection is
a failed order, because the form's leverage would otherwise be a lie.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from condor.fetchers.executors import describe_executor_error
from condor.venue_capabilities import trading_profile

logger = logging.getLogger(__name__)


async def apply_venue_account_settings(
    client: Any, account: str, config: dict
) -> Optional[bool]:
    """Set leverage, then margin mode, for a venue that requires it.

    Returns ``None`` when this venue does not confirm account settings (the
    caller leaves the flag off the response). ``True`` when every requested
    setting was applied. ``False`` when a margin mode was requested and this
    API has no margin-mode route. A leverage error propagates.
    """
    connector = str(config.get("connector_name") or "")
    profile = trading_profile(connector)
    if profile is None or not profile.confirms_account_settings:
        return None

    trading = getattr(client, "trading", None)
    if trading is None:
        return None

    pair = str(config.get("trading_pair") or "")
    leverage = config.get("leverage")
    # The form's untouched default is 1x (10x on a position executor). An open
    # MEXC position is already levered, and calling set_leverage to the default
    # is what moves that position. ``leverage_explicit`` is set only when the
    # user edits the field. Matching the open leverage also skips the call:
    # setting 2x on a 2x position is the change the order was not supposed to make.
    explicit = bool(config.get("leverage_explicit"))
    if leverage is not None and pair and profile.leverage:
        requested = int(float(leverage))
        known, current = await _open_position_leverage(
            trading, account, connector, pair
        )
        if known and current is not None and (not explicit or current == requested):
            config["leverage"] = current
        elif not known:
            logger.warning(
                "Could not read open positions for %s %s; leaving leverage unchanged",
                connector,
                pair,
            )
        else:
            await trading.set_leverage(account, connector, pair, requested)

    mode = config.get("margin_mode")
    if not mode or not profile.margin_modes:
        return True
    return await _set_margin_mode(trading, account, connector, pair, str(mode))


async def _set_margin_mode(
    trading: Any, account: str, connector: str, pair: str, mode: str
) -> bool:
    method = getattr(trading, "set_margin_mode", None)
    if method is not None:
        await method(account, connector, pair, mode)
        return True
    try:
        await trading._post(
            f"/trading/{account}/{connector}/margin-mode",
            json={"trading_pair": pair, "margin_mode": mode},
        )
    except Exception as exc:
        status, _message = describe_executor_error(exc)
        if status == 404:
            logger.info(
                "margin-mode route is not on this API; %s keeps the connector's current mode",
                connector,
            )
            return False
        raise
    return True


def strip_order_only_fields(executor_type: str, config: dict) -> None:
    """Drop fields the order executor's config model does not declare.

    Range iceberg's config declares ``margin_mode``. The order, position, grid
    and DCA configs do not, and a strict model rejects the extra key. The
    value has already been read by :func:`apply_venue_account_settings`.
    ``leverage_explicit`` is Condor's own flag on every executor type.
    """
    config.pop("leverage_explicit", None)
    if executor_type == "range_iceberg_executor":
        return
    config.pop("margin_mode", None)


def _position_rows(result: Any) -> list:
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        for key in ("data", "positions"):
            rows = result.get(key)
            if isinstance(rows, list):
                return rows
    return []


def _as_float(value: object) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


async def _open_position_leverage(
    trading: Any, account: str, connector: str, pair: str
) -> tuple[bool, Optional[int]]:
    """``(could_read, leverage)`` for a non-zero position on this pair.

    A client with no ``get_positions`` is treated as "no open position", which
    is what the older fakes are. A call that raises is "could not read": the
    caller then leaves the account's leverage alone rather than guessing.
    """
    method = getattr(trading, "get_positions", None)
    if method is None:
        return True, None
    try:
        result = await method(
            account_names=[account] if account else None,
            connector_names=[connector],
            limit=200,
        )
    except Exception as exc:
        logger.warning("Could not read positions for %s: %s", connector, exc)
        return False, None

    want = pair.replace("_", "-").upper()
    for row in _position_rows(result):
        if not isinstance(row, dict):
            continue
        row_pair = str(row.get("trading_pair") or row.get("symbol") or "")
        row_pair = row_pair.replace("_", "-").upper()
        if row_pair != want:
            continue
        amount = _as_float(row.get("amount"))
        if amount is None:
            amount = _as_float(row.get("net_amount_base"))
        if not amount:
            continue
        leverage = _as_float(row.get("leverage"))
        if leverage is None or leverage < 1:
            continue
        return True, int(leverage)
    return True, None
