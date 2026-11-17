"""Active orders for the trade page, and cancelling one of them.

The page already drew the book and the fills. It did not draw the orders the
account still has working, so a MEXC limit that rested after a create was
invisible and could not be cancelled from the same pane as the other venues.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query

from condor.web.auth import require_server_access
from condor.web.models import WebUser
from condor.web.routes._deeds import record_ui_deed
from condor.web.routes._errors import upstream_error
from config_manager import get_config_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["orders"])

_ACCOUNT = "master_account"


def _number(value: object) -> float:
    try:
        if value is None or value == "":
            return 0.0
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def normalize_order(raw: dict) -> dict:
    """One active-order row, with the field names the trade page reads."""
    return {
        "client_order_id": str(
            raw.get("client_order_id")
            or raw.get("clientOrderId")
            or raw.get("id")
            or ""
        ),
        "trading_pair": str(raw.get("trading_pair") or raw.get("tradingPair") or ""),
        "trade_type": str(raw.get("trade_type") or raw.get("side") or ""),
        "order_type": str(raw.get("order_type") or raw.get("orderType") or ""),
        "amount": _number(
            raw.get("amount") if raw.get("amount") is not None else raw.get("quantity")
        ),
        "price": _number(raw.get("price")),
        "status": str(raw.get("status") or ""),
    }


@router.get("/servers/{name}/orders/active")
async def active_orders(
    name: str,
    connector: str = Query(default=""),
    trading_pair: str = Query(default=""),
    user: WebUser = Depends(require_server_access),
):
    """Working orders, narrowed to one connector and pair when those are given."""
    cm = get_config_manager()
    client = await cm.get_client(name)

    from condor.fetchers.orders import fetch_active_orders

    try:
        rows = await fetch_active_orders(
            client,
            limit="100",
            strict=True,
            connector_names=[connector] if connector else None,
            trading_pairs=[trading_pair] if trading_pair else None,
        )
    except Exception as e:
        logger.exception("Failed to fetch active orders on '%s'", name)
        raise upstream_error("Failed to fetch active orders", e)

    orders = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        # A server that ignored the connector filter would mix other venues in.
        row_connector = str(raw.get("connector_name") or raw.get("connector") or "")
        if connector and row_connector and row_connector != connector:
            continue
        order = normalize_order(raw)
        if (
            trading_pair
            and order["trading_pair"]
            and order["trading_pair"] != trading_pair
        ):
            continue
        orders.append(order)
    return {"orders": orders}


@router.post("/servers/{name}/orders/{order_id}/cancel")
async def cancel_order(
    name: str,
    order_id: str,
    connector: str = Query(...),
    user: WebUser = Depends(require_server_access),
):
    """Cancel one working order by its client order id."""
    if not order_id:
        raise HTTPException(status_code=400, detail="Order id is required")
    cm = get_config_manager()
    client = await cm.get_client(name)
    try:
        result = await client.trading.cancel_order(_ACCOUNT, connector, order_id)
    except Exception as e:
        logger.exception("Failed to cancel order %s on '%s'", order_id, name)
        raise upstream_error("Failed to cancel order", e)
    record_ui_deed(
        user,
        verb="cancel_order",
        summary=f"Cancel order {order_id[:12]} on {connector}",
    )
    return {"status": "ok", "result": result}
