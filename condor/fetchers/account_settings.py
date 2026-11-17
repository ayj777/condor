"""Account leverage and margin before an executor is created.

A MEXC order does not carry leverage or margin mode by itself. The account
already has both, and the open position uses them. Range iceberg then calls
``confirm_leverage_and_margin`` with whatever this config still contains, so a
default of 1x or ISOLATED left in the config is a change to that position.

Create never calls ``set_leverage``. That call is ``confirm_leverage``, and
only after the user applies a value that is at least 1 and differs from the
open position. Margin mode is sent only when the user edited it and the new
value differs. If the open book cannot be read, the create is aborted.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from condor.fetchers.executors import describe_executor_error
from condor.venue_capabilities import trading_profile

logger = logging.getLogger(__name__)


class AccountSettingsError(Exception):
    """The create or the leverage change must not be sent."""


async def apply_venue_account_settings(
    client: Any, account: str, config: dict
) -> Optional[bool]:
    """Prepare leverage and margin for a venue that confirms them on the account.

    Returns ``None`` when this venue does not confirm account settings.
    ``True`` when nothing still needs a margin write, or the write landed.
    ``False`` when the user asked for a margin change and this API has no
    margin-mode route. The field is removed in that case so range iceberg
    cannot apply it either. A leverage below 1, or a book that cannot be
    read, raises :class:`AccountSettingsError` and the caller does not create.
    """
    connector = str(config.get("connector_name") or "")
    profile = trading_profile(connector)
    if profile is None or not profile.confirms_account_settings:
        return None

    trading = getattr(client, "trading", None)
    if trading is None:
        raise AccountSettingsError(
            "Cannot read open positions, so the order was not sent."
        )

    pair = str(config.get("trading_pair") or "")
    _reject_bad_leverage(config.get("leverage"))
    rows = await _open_rows(client, connector)
    matched = _match_row(rows, pair, config.get("side"))

    if matched is not None:
        current = _optional_float(matched.get("leverage"))
        if current is None or current < 1:
            # Range iceberg confirms whatever number is left in the config.
            # An unread leverage cannot be told apart from the form default.
            raise AccountSettingsError(
                "Cannot read the leverage on the open "
                f"{pair or connector} position, so the order was not sent."
            )
        config["leverage"] = int(current)

    if not profile.margin_modes:
        config.pop("margin_mode", None)
        return True

    return await _apply_margin(trading, account, connector, pair, config, matched)


async def confirm_leverage(
    client: Any,
    account: str,
    connector: str,
    pair: str,
    leverage: int,
    side: object = None,
) -> None:
    """Set leverage only when the user confirmed a value that differs.

    This is not part of placing an order. A value below 1 is rejected before
    any account call. The same value the position already has is not sent.
    """
    if leverage < 1:
        raise AccountSettingsError("Leverage must be at least 1.")
    profile = trading_profile(connector)
    if profile is None or not profile.confirms_account_settings or not profile.leverage:
        raise AccountSettingsError(f"{connector} does not confirm leverage here.")
    trading = getattr(client, "trading", None)
    if trading is None or not hasattr(trading, "set_leverage"):
        raise AccountSettingsError("This API cannot set leverage.")
    rows = await _open_rows(client, connector)
    matched = _match_row(rows, pair, side)
    current = _optional_float(matched.get("leverage")) if matched else None
    if matched is not None and (current is None or current < 1):
        raise AccountSettingsError(
            "Cannot read the leverage on the open position, so it was not changed."
        )
    if current is not None and int(current) == int(leverage):
        return
    await trading.set_leverage(account, connector, pair, int(leverage))


def strip_order_only_fields(executor_type: str, config: dict) -> None:
    """Drop flags the executor config model does not declare.

    ``margin_mode`` stays only on a range iceberg, and only when the account
    write above kept it. Every other executor rejects the extra key.
    """
    config.pop("leverage_explicit", None)
    config.pop("leverage_confirmed", None)
    config.pop("margin_explicit", None)
    if executor_type == "range_iceberg_executor" and config.get("margin_mode"):
        return
    config.pop("margin_mode", None)


def _reject_bad_leverage(value: object) -> None:
    if value is None or value == "":
        return
    number = _optional_float(value)
    if number is None or number < 1:
        raise AccountSettingsError("Leverage must be at least 1.")


async def _apply_margin(
    trading: Any,
    account: str,
    connector: str,
    pair: str,
    config: dict,
    matched: Optional[dict],
) -> bool:
    explicit = bool(config.get("margin_explicit"))
    requested = _margin_name(config.get("margin_mode")) if explicit else None
    # The documented MEXC row has leverage and no margin field. An order that
    # does not ask to change margin must not be refused for that absence.
    if not explicit or requested is None:
        config.pop("margin_mode", None)
        return True
    if matched is not None:
        current = _margin_name(
            matched.get("margin_mode")
            if matched.get("margin_mode") not in (None, "")
            else (
                matched.get("marginMode")
                if matched.get("marginMode") not in (None, "")
                else (
                    matched.get("open_type")
                    if matched.get("open_type") not in (None, "")
                    else matched.get("openType")
                )
            )
        )
        if current is None:
            raise AccountSettingsError(
                "Cannot read the margin mode on the open "
                f"{pair or connector} position, so the order was not sent."
            )
        if requested == current:
            config.pop("margin_mode", None)
            return True

    applied = await _set_margin_mode(trading, account, connector, pair, requested or "")
    if not applied:
        # A 404 must not leave the mode in the config for range iceberg to apply.
        config.pop("margin_mode", None)
        return False
    config["margin_mode"] = requested
    return True


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
                "margin-mode route is not on this API; %s keeps its current mode",
                connector,
            )
            return False
        raise
    return True


async def _open_rows(client: Any, connector: str) -> list[dict]:
    """Every open position on this connector, walking the cursor.

    A missing method and a failed read are the same failure: the book is
    unknown, and a create that guessed would be free to change it.
    """
    trading = getattr(client, "trading", None)
    if trading is None or not hasattr(trading, "get_positions"):
        raise AccountSettingsError(
            "Cannot read open positions, so the order was not sent."
        )
    try:
        from condor.fetchers.positions import PositionBookError, fetch_positions

        rows = await fetch_positions(client, connector_name=connector, strict=True)
    except PositionBookError as exc:
        raise AccountSettingsError(str(exc)) from exc
    except AccountSettingsError:
        raise
    except Exception as exc:
        logger.warning("Could not read positions for %s: %s", connector, exc)
        raise AccountSettingsError(
            "Cannot read open positions, so the order was not sent."
        ) from exc
    return [row for row in rows if isinstance(row, dict)]


def _match_row(rows: list[dict], pair: str, side: object) -> Optional[dict]:
    """The open row this order would change.

    Hedge mode can hold both sides, so the form's side wins when both are
    open. One row on the pair is that pair's position even when the form
    side is the reducing side.
    """
    want = _pair(pair)
    on_pair = []
    for row in rows:
        row_pair = _pair(row.get("trading_pair") or row.get("symbol"))
        if want and row_pair != want:
            continue
        amount = _optional_float(row.get("amount"))
        if amount is None:
            amount = _optional_float(row.get("net_amount_base"))
        if not amount:
            continue
        on_pair.append(row)
    if not on_pair:
        return None
    want_side = _side_key(side)
    sided = [
        row
        for row in on_pair
        if _side_key(row.get("position_side") or row.get("side")) == want_side
    ]
    if sided:
        return sided[0]
    if len(on_pair) == 1:
        return on_pair[0]
    return None


def _pair(raw: object) -> str:
    return str(raw or "").strip().replace("_", "-").upper()


def _side_key(raw: object) -> str:
    text = str(raw or "").strip()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    text = text.upper()
    if text in ("LONG", "BUY", "1"):
        return "LONG"
    if text in ("SHORT", "SELL", "2"):
        return "SHORT"
    return text


def _optional_float(value: object) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _margin_name(value: object) -> Optional[str]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) or (
        isinstance(value, str) and value.strip().isdigit()
    ):
        number = int(float(value))
        # MEXC openType: 1 isolated, 2 cross.
        if number == 1:
            return "ISOLATED"
        if number == 2:
            return "CROSS"
        return None
    text = str(value).strip()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    text = text.upper()
    if text in ("ISOLATED", "CROSS"):
        return text
    return None
