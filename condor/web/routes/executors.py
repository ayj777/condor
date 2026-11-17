from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Query

from condor.server_data_service import ServerDataType, get_server_data_service

logger = logging.getLogger(__name__)


from condor.asyncutil import SingleFlight
from condor.fetchers.executors import EXECUTORS_POLL_MAX, MAX_EXECUTORS_FETCH
from condor.fetchers.executors import extract_executors_list as _extract_executors_list
from condor.fetchers.executors import fetch_all_executors, summarize_executors_by_quote
from condor.web.auth import require_server_access
from condor.web.models import (
    CreateExecutorRequest,
    ExecutorInfo,
    ExecutorPeriodSummary,
    WebUser,
)
from condor.web.routes._deeds import record_ui_deed
from condor.web.routes._errors import upstream_error
from config_manager import get_config_manager

router = APIRouter(tags=["executors"])


# Cursor scheme for pages served as an offset into the executor stream rather
# than by an opaque API cursor.
_SDS_OFFSET_PREFIX = "__sds_offset__"


# Windows the dashboard's KPI strip offers, in seconds, with the TTL each
# aggregate is cached for. A period total is not a live number -- the longer the
# window, the less one new executor moves it, so the month total is allowed to
# age far more than the day's. The floor matters because computing one of these
# walks the whole executor history: without it, every browser tab polling the
# strip would re-walk it.
_PERIOD_SECONDS: dict[str, int] = {"1D": 86400, "1W": 7 * 86400, "1M": 30 * 86400}
_PERIOD_TTLS: dict[str, int] = {"1D": 60, "1W": 300, "1M": 900}

# (server, period) -> (computed_at, summary). Bounded by servers x periods.
_summary_cache: dict[tuple[str, str], tuple[float, ExecutorPeriodSummary]] = {}

# One executor walk per server at a time, shared by every concurrent caller
# (PERF-580). The TTL cache above only helps a request that arrives *after* an
# answer has landed; the KPI strip refetches on a 60s interval against a 60s TTL
# for 1D, so two open tabs used to fire two concurrent walks of up to
# MAX_EXECUTORS_FETCH / EXECUTORS_PAGE_SIZE sequential cursor pages each.
# Keyed by server, not by (server, period): the walk is identical for all three
# windows, which are filtered out of the same rows client-side.
_summary_walks = SingleFlight()


@router.get("/servers/{name}/executors", response_model=list[ExecutorInfo])
async def list_executors(
    name: str,
    executor_type: str = Query(default="", description="Filter by executor type"),
    trading_pair: str = Query(default="", description="Filter by trading pair"),
    status: str = Query(default="", description="Filter by status"),
    controller_id: str = Query(default="", description="Filter by controller id"),
    limit: int = Query(
        default=0,
        ge=0,
        le=MAX_EXECUTORS_FETCH,
        description="Max executors to return (0 = default SDS cache)",
    ),
    user: WebUser = Depends(require_server_access),
):
    cm = get_config_manager()

    # For filtered queries or when a custom limit is requested, go direct to API.
    # For unfiltered default requests, use the SDS cache.
    if executor_type or trading_pair or status or controller_id or limit:
        client = await cm.get_client(name)
        api_kwargs = {}
        if executor_type:
            api_kwargs["executor_types"] = [executor_type]
        if trading_pair:
            api_kwargs["trading_pairs"] = [trading_pair]
        if status:
            api_kwargs["status"] = status
        if controller_id:
            api_kwargs["controller_ids"] = [controller_id]
        try:
            executors_list = await fetch_all_executors(
                client,
                max_items=limit or MAX_EXECUTORS_FETCH,
                **api_kwargs,
            )
            result = executors_list
        except Exception as e:
            logger.exception("Failed to fetch executors for server %s", name)
            raise upstream_error("Failed to fetch executors", e)
    else:
        try:
            result = await get_server_data_service().get_or_fetch(
                name, ServerDataType.EXECUTORS
            )
        except Exception as e:
            logger.exception("Failed to fetch executors for server %s", name)
            raise upstream_error("Failed to fetch executors", e)
        if result is None:
            raise HTTPException(status_code=502, detail="Failed to fetch executors")

    executors_list = _extract_executors_list(result)

    items: list[ExecutorInfo] = []
    for ex in executors_list:
        info = ExecutorInfo.from_raw(ex)
        if info:
            items.append(info)
    return items


def _offset_page(rows: list[dict], offset: int, limit: int) -> dict:
    """Build a page response for the offset-cursor scheme over ``rows``."""
    items: list[ExecutorInfo] = []
    for ex in rows[offset : offset + limit]:
        info = ExecutorInfo.from_raw(ex)
        if info:
            items.append(info)
    has_more = len(rows) > offset + limit
    return {
        "executors": items,
        "next_cursor": _SDS_OFFSET_PREFIX + str(offset + limit) if has_more else None,
    }


@router.get("/servers/{name}/executors/page")
async def list_executors_page(
    name: str,
    cursor: str = Query(default="", description="Pagination cursor from previous page"),
    limit: int = Query(default=50, ge=1, le=500, description="Page size"),
    executor_type: str = Query(default=""),
    trading_pair: str = Query(default=""),
    status: str = Query(default=""),
    controller_id: str = Query(default=""),
    user: WebUser = Depends(require_server_access),
):
    """Fetch a single page of executors with a next_cursor for progressive loading.

    Designed for the frontend to stream executors in chunks (e.g. 50 at a time)
    and render them as they arrive instead of waiting for the full dataset.

    First page with no filters: served from SDS cache if available (instant).
    Scrolling past the cached prefix keeps the same offset cursor and is served
    from the API instead, so the stream continues past the poll's page budget.
    """
    cm = get_config_manager()

    has_filters = bool(executor_type or trading_pair or status or controller_id)

    # Offset paging over the SDS cache: the unfiltered first page, and any page
    # whose cursor was handed out by a previous one.
    offset: int | None = None
    if not has_filters:
        if not cursor:
            offset = 0
        elif cursor.startswith(_SDS_OFFSET_PREFIX):
            offset = int(cursor[len(_SDS_OFFSET_PREFIX) :] or 0)

    if offset is not None:
        cached = get_server_data_service().get(name, ServerDataType.EXECUTORS)
        cached_rows = _extract_executors_list(cached) if cached is not None else []
        # The poll caps its walk at EXECUTORS_POLL_MAX, so a cache of exactly
        # that length is only a prefix of the history: just a short cache proves
        # there is nothing past it.
        cache_is_whole = cached is not None and len(cached_rows) < EXECUTORS_POLL_MAX
        if offset + limit < len(cached_rows) or cache_is_whole:
            return _offset_page(cached_rows, offset, limit)

        if cursor:
            # Scrolled past the cached prefix, or the cache expired mid-scroll.
            # An offset cursor has no API equivalent, so keep the scheme going:
            # walk far enough to fill this page and to tell if another follows.
            client = await cm.get_client(name)
            try:
                rows = await fetch_all_executors(client, max_items=offset + limit + 1)
            except Exception as e:
                logger.exception("Failed to page executors for server %s", name)
                raise upstream_error("Failed to fetch executors", e)
            return _offset_page(rows, offset, limit)
        # Cold cache on the first page: fall through to opaque API cursors,
        # which page the rest of the scroll in one request each.

    client = await cm.get_client(name)
    kwargs: dict = {"limit": limit}
    if cursor and not cursor.startswith(_SDS_OFFSET_PREFIX):
        kwargs["cursor"] = cursor
    if executor_type:
        kwargs["executor_types"] = [executor_type]
    if trading_pair:
        kwargs["trading_pairs"] = [trading_pair]
    if status:
        kwargs["status"] = status
    if controller_id:
        kwargs["controller_ids"] = [controller_id]

    try:
        result = await client.executors.search_executors(**kwargs)
    except Exception as e:
        logger.exception("Failed to page executors for server %s", name)
        raise upstream_error("Failed to fetch executors", e)

    page = _extract_executors_list(result)
    next_cursor = None
    if isinstance(result, dict):
        next_cursor = result.get("next_cursor") or result.get("cursor")
        pagination = result.get("pagination")
        if not next_cursor and isinstance(pagination, dict):
            next_cursor = pagination.get("next_cursor") or pagination.get("cursor")
    # If the page came back short, treat as end-of-stream regardless of cursor.
    if len(page) < limit:
        next_cursor = None

    items = []
    for ex in page:
        info = ExecutorInfo.from_raw(ex)
        if info:
            items.append(info)
    return {"executors": items, "next_cursor": next_cursor or None}


async def _usd_summary(
    server: str, period: str, by_quote: dict[str, dict[str, float]]
) -> ExecutorPeriodSummary:
    """Fold per-quote totals into one USD-denominated summary.

    One rate lookup per quote asset, not per executor, and served from the cached
    ticker pool. A quote with no path to USD is added at face value and flips
    ``converted`` — the same fallback the strip's client-side ``convert()`` made,
    but reported instead of silent.

    The resolution itself belongs to :func:`condor.quote_conversion.resolve_usd_rates`,
    which the archived-run path already uses (CORR-602). The copy that used to live
    here asked the pool for ``DAI-USDT`` and called the total "approximate" on a
    server with no such market, while the same history read as converted elsewhere —
    the shared helper short-circuits every stablecoin quote to 1.0 instead, so the
    two surfaces agree on both the dollars and the confidence flag.
    """
    from condor.quote_conversion import resolve_usd_rates

    quote_rates = await resolve_usd_rates(server, set(by_quote))

    pnl = 0.0
    volume = 0.0
    count = 0
    for quote, totals in by_quote.items():
        rate = quote_rates.rates.get(quote, 1.0)
        pnl += totals["pnl"] * rate
        volume += totals["volume"] * rate
        count += int(totals["count"])

    return ExecutorPeriodSummary(
        period=period,
        pnl=pnl,
        volume=volume,
        count=count,
        converted=quote_rates.converted,
    )


async def _walk_and_summarize(server: str, client) -> dict[str, ExecutorPeriodSummary]:
    """Walk a server's executor history once and total *every* window from it.

    The walk is the expensive part — up to ``MAX_EXECUTORS_FETCH /
    EXECUTORS_PAGE_SIZE`` sequential cursor pages the SDS rate limiter never
    sees — and it does not depend on the period: ``summarize_executors_by_quote``
    filters on the executor's start timestamp client-side, so the 1M window's
    rows are a strict superset of 1W's and 1D's. Computing the three totals in
    one pass is therefore exactly the arithmetic the three separate requests
    performed, over the same rows in the same order, and costs one walk instead
    of three (PERF-580).

    Each total is stamped into ``_summary_cache`` here, so the per-period TTLs
    stay the read gate: a 1D request re-walks after 60s, but the 1W total it
    also refreshed is still served from cache for its own 300s.
    """
    now = time.time()
    executors = await fetch_all_executors(client)

    summaries: dict[str, ExecutorPeriodSummary] = {}
    for window_period, window in _PERIOD_SECONDS.items():
        summary = await _usd_summary(
            server,
            window_period,
            summarize_executors_by_quote(executors, now - window),
        )
        summaries[window_period] = summary
        _summary_cache[(server, window_period)] = (now, summary)
    return summaries


@router.get("/servers/{name}/executors/summary", response_model=ExecutorPeriodSummary)
async def executors_summary(
    name: str,
    period: str = Query(default="1D", description="Window: 1D, 1W or 1M"),
    user: WebUser = Depends(require_server_access),
):
    """PnL, volume and executor count over a period, across the whole history.

    The dashboard's KPI strip used to compute this in the browser by summing the
    executor list it already had. That list is the SDS cache, which the poll
    bounds to a single page (``EXECUTORS_POLL_MAX``, PERF-117), so on a busy
    server the 1W and 1M tiles silently reported the newest page instead of the
    period — a wrong number with nothing to distinguish it from a right one.

    A period total belongs here, over the full history: this walks it with
    ``fetch_all_executors``, on demand and cached per period, leaving the 2s poll
    at its one request per tick.

    The walk itself is shared (PERF-580). It is single-flighted per server, so
    two tabs missing a cold cache at the same instant wait on one walk rather
    than racing two, and one walk totals all three windows — switching the
    strip's period no longer re-reads a history the previous period already had.
    """
    cm = get_config_manager()

    period = period.upper()
    window = _PERIOD_SECONDS.get(period)
    if window is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown period '{period}': expected one of "
            + ", ".join(_PERIOD_SECONDS),
        )

    now = time.time()
    cached = _summary_cache.get((name, period))
    if cached is not None and now - cached[0] < _PERIOD_TTLS[period]:
        return cached[1]

    client = await cm.get_client(name)
    try:
        summaries = await _summary_walks.run(
            name, lambda: _walk_and_summarize(name, client)
        )
    except Exception as e:
        logger.exception("Failed to summarize executors for server %s", name)
        raise upstream_error("Failed to fetch executors", e)

    return summaries[period]


async def _ensure_dex_tokens_listed(client, config: dict) -> None:
    """Register a DEX executor's tokens with Gateway before it is created.

    The pool workspace already does this when it opens, so for the web UI this is
    a no-op resolved from an in-process memo. It exists for the callers that never
    open one — agents, Telegram, MCP — because an unlisted mint reads as a zero
    balance in Gateway, which is enough to have an order rejected for funds the
    wallet is holding.

    Best effort by design: a token that cannot be registered is not a reason to
    refuse an order Gateway may well execute anyway.
    """
    connector = str(config.get("connector_name") or "")
    if not connector:
        return
    try:
        from condor.fetchers.gateway_tokens import (
            ensure_tokens_listed,
            token_addresses,
        )
        from condor.pool_data import GECKO_TO_GATEWAY_NETWORK, NETWORK_TO_GECKO

        # A CEX connector ("binance") maps to no chain and drops out here; only a
        # Gateway network id ("solana-mainnet-beta") reaches the token list.
        network = GECKO_TO_GATEWAY_NETWORK.get(NETWORK_TO_GECKO.get(connector, ""))
        if not network:
            return
        addresses = token_addresses(config.get("trading_pair"))
        if addresses:
            await ensure_tokens_listed(client, network, addresses)
    except Exception as e:
        logger.warning("could not ensure tokens for %s: %s", connector, e)


@router.post("/servers/{name}/executors")
async def create_executor_endpoint(
    name: str,
    body: CreateExecutorRequest,
    user: WebUser = Depends(require_server_access),
):
    cm = get_config_manager()

    client = await cm.get_client(name)

    # Inject executor type into config
    config = {**body.config, "type": body.executor_type}

    await _ensure_dex_tokens_listed(client, config)

    from condor.fetchers.account_settings import (
        AccountSettingsError,
        apply_venue_account_settings,
        strip_order_only_fields,
    )
    from condor.fetchers.executors import create_executor
    from condor.venue_capabilities import iceberg_margin_block

    blocked = iceberg_margin_block(
        str(config.get("connector_name") or ""), body.executor_type
    )
    if blocked:
        raise HTTPException(status_code=400, detail=blocked)

    margin_applied = None
    try:
        # Before the create, and before unknown fields are stripped. This does
        # not call set_leverage. Margin is omitted unless the user edited it.
        # It refuses the create when the open book cannot be read.
        margin_applied = await apply_venue_account_settings(
            client, body.account_name, config
        )
    except AccountSettingsError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Failed to apply account settings on '%s'", name)
        raise upstream_error("Failed to set leverage or margin mode", e)
    strip_order_only_fields(body.executor_type, config)

    try:
        # No controller_id: the fetcher takes none, so the trading API applies its
        # own ``main`` default. See ``CreateExecutorRequest`` before adding one.
        result = await create_executor(client, config, account_name=body.account_name)
    except Exception as e:
        raise upstream_error("Failed to create executor", e)
    executor_id = ""
    if isinstance(result, dict):
        executor_id = str(result.get("executor_id") or result.get("id") or "")
    # ``create_lp_executor`` and friends — the same verbs the typed tools carry,
    # so FEAT-100's tick join reads a UI create exactly as it reads an agent's.
    record_ui_deed(
        user,
        verb=f"create_{body.executor_type}",
        summary=(
            f"Create {body.executor_type.removesuffix('_executor')} executor on "
            f"{config.get('trading_pair') or '?'}"
        ),
    )
    response = {"status": "ok", "executor_id": executor_id}
    # Present only when this venue confirms account settings. False means the
    # user asked for a margin change and this API could not apply it. The mode
    # was removed from the config either way.
    if margin_applied is not None:
        response["margin_mode_applied"] = margin_applied
    return response


@router.post("/servers/{name}/executors/{executor_id}/stop")
async def stop_executor_endpoint(
    name: str,
    executor_id: str,
    keep_position: bool = Query(default=False),
    user: WebUser = Depends(require_server_access),
):
    cm = get_config_manager()

    client = await cm.get_client(name)

    from condor.fetchers.executors import stop_executor

    if not keep_position:
        await _refuse_oversized_close(client, executor_id)
    try:
        result = await stop_executor(client, executor_id, keep_position=keep_position)
    except Exception as e:
        raise upstream_error("Failed to stop executor", e)
    suffix = ", keeping the position" if keep_position else ""
    record_ui_deed(
        user,
        verb="stop_executor",
        summary=f"Stop executor {executor_id[:12]}...{suffix}",
    )
    return {"status": "ok", "result": result}


@router.post("/servers/{name}/executors/{executor_id}/resume")
async def resume_executor_endpoint(
    name: str,
    executor_id: str,
    user: WebUser = Depends(require_server_access),
):
    """Resume a paused executor.

    The stock client has no resume method. This route then answers 501 and
    the trade page hides the button. When the method exists, a child size
    that is off the pair step is refused so resume does not repeat it.
    """
    cm = get_config_manager()
    client = await cm.get_client(name)

    from condor.fetchers.executors import describe_executor_error

    if not _resume_method(client):
        raise HTTPException(
            status_code=501,
            detail="This trading API does not support resuming executors",
        )
    await _refuse_offstep_resume(client, executor_id)
    try:
        result = await _resume_executor(client, executor_id)
    except Exception as e:
        status, _message = describe_executor_error(e)
        if status == 404:
            raise HTTPException(
                status_code=501,
                detail="This trading API does not support resuming executors",
            )
        raise upstream_error("Failed to resume executor", e)
    record_ui_deed(
        user,
        verb="resume_executor",
        summary=f"Resume executor {executor_id[:12]}...",
    )
    return {"status": "ok", "result": result}


def _resume_method(client):
    executors = getattr(client, "executors", None)
    method = getattr(executors, "resume_executor", None)
    return method


async def _resume_executor(client, executor_id: str):
    method = _resume_method(client)
    if method is None:
        raise HTTPException(
            status_code=501,
            detail="This trading API does not support resuming executors",
        )
    return await method(executor_id)


@router.get("/servers/{name}/executors/resume-supported")
async def resume_supported(
    name: str,
    user: WebUser = Depends(require_server_access),
):
    """Whether this API client can resume an executor. The button stays hidden when it cannot."""
    cm = get_config_manager()
    client = await cm.get_client(name)
    return {"supported": _resume_method(client) is not None}


@router.post("/servers/{name}/account/leverage")
async def confirm_account_leverage(
    name: str,
    body: dict,
    user: WebUser = Depends(require_server_access),
):
    """Set leverage on its own. Placing an order does not call this."""
    from condor.fetchers.account_settings import AccountSettingsError, confirm_leverage

    cm = get_config_manager()
    client = await cm.get_client(name)
    try:
        leverage = int(float(body.get("leverage")))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Leverage must be at least 1.")
    try:
        await confirm_leverage(
            client,
            str(body.get("account_name") or "master_account"),
            str(body.get("connector_name") or ""),
            str(body.get("trading_pair") or ""),
            leverage,
            body.get("side"),
        )
    except AccountSettingsError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Failed to set leverage on '%s'", name)
        raise upstream_error("Failed to set leverage", e)
    record_ui_deed(
        user,
        verb="set_leverage",
        summary=f"Set leverage {leverage} on {body.get('trading_pair') or '?'}",
    )
    return {"status": "ok"}


def _row_side(raw: object) -> str:
    text = str(raw or "").strip()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    text = text.upper()
    if text in ("LONG", "BUY", "1"):
        return "LONG"
    if text in ("SHORT", "SELL", "2"):
        return "SHORT"
    return ""


def executor_book_side(executor: dict) -> str:
    """The position side this executor filled, not the other hedge side.

    An explicit position side wins. Otherwise an open buy is a long and an
    open sell is a short. A close sell reduces a long, and a close buy
    reduces a short. Empty means the side could not be read.
    """
    config = executor.get("config") if isinstance(executor.get("config"), dict) else {}
    explicit = _row_side(config.get("position_side") or executor.get("position_side"))
    if explicit:
        return explicit
    action = str(
        config.get("position_action") or executor.get("position_action") or "OPEN"
    ).upper()
    if "." in action:
        action = action.rsplit(".", 1)[-1]
    trade = _row_side(config.get("side") or executor.get("side"))
    if action == "CLOSE":
        if trade == "SHORT":
            return "LONG"
        if trade == "LONG":
            return "SHORT"
        return ""
    return trade


def _filled_base(executor: dict) -> float:
    info = (
        executor.get("custom_info")
        if isinstance(executor.get("custom_info"), dict)
        else {}
    )
    for value in (
        info.get("filled_amount"),
        executor.get("filled_amount"),
        info.get("filled_base"),
    ):
        try:
            if value is None or value == "":
                continue
            return abs(float(value))
        except (TypeError, ValueError):
            continue
    return 0.0


async def _refuse_oversized_close(client, executor_id: str) -> None:
    """A close sells only what this executor filled, and only reduce-only.

    The stock stop call has no reduce-only size. When the exchange position is
    larger than the fill, the stop is refused instead of closing the rest.
    """
    try:
        executor = await client.executors.get_executor(executor_id)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="Cannot read what this executor filled, so it was not closed.",
        ) from exc
    if not isinstance(executor, dict):
        raise HTTPException(
            status_code=400,
            detail="Cannot read what this executor filled, so it was not closed.",
        )
    config = executor.get("config") if isinstance(executor.get("config"), dict) else {}
    connector = str(
        executor.get("connector_name") or config.get("connector_name") or ""
    )
    pair = str(executor.get("trading_pair") or config.get("trading_pair") or "")
    filled = _filled_base(executor)
    try:
        from condor.fetchers.positions import fetch_positions

        rows = await fetch_positions(
            client, connector_name=connector or None, strict=True
        )
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="Cannot read the exchange position, so the stop will not close it.",
        ) from exc
    want = pair.replace("_", "-").upper()
    side = executor_book_side(executor)
    venue = 0.0
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_pair = str(row.get("trading_pair") or "").replace("_", "-").upper()
        if want and row_pair != want:
            continue
        row_side = _row_side(row.get("position_side") or row.get("side"))
        if side and row_side != side:
            continue
        try:
            amount = abs(float(row.get("amount") or 0))
        except (TypeError, ValueError):
            amount = 0.0
        venue = max(venue, amount)
    if venue > filled + 1e-9:
        which = f" of the {side.lower()}" if side else ""
        raise HTTPException(
            status_code=400,
            detail=(
                f"This stop would close {venue:g}{which} but the executor only "
                f"filled {filled:g}. Keep the position."
            ),
        )


def _child_amounts(executor: dict) -> list[float]:
    info = (
        executor.get("custom_info")
        if isinstance(executor.get("custom_info"), dict)
        else {}
    )
    amounts: list[float] = []
    levels = info.get("levels")
    if isinstance(levels, list):
        for level in levels:
            if not isinstance(level, dict):
                continue
            try:
                amount = float(level.get("amount") or 0)
            except (TypeError, ValueError):
                continue
            if amount > 0:
                amounts.append(amount)
    return amounts


async def _refuse_offstep_resume(client, executor_id: str) -> None:
    """Do not resume by repeating a child size that is off the pair step."""
    try:
        executor = await client.executors.get_executor(executor_id)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="Cannot read this executor, so it was not resumed.",
        ) from exc
    if not isinstance(executor, dict):
        raise HTTPException(
            status_code=400, detail="Cannot read this executor, so it was not resumed."
        )
    amounts = _child_amounts(executor)
    if not amounts:
        raise HTTPException(
            status_code=400,
            detail="Cannot read the child order sizes, so resume was not sent.",
        )
    config = executor.get("config") if isinstance(executor.get("config"), dict) else {}
    connector = str(
        executor.get("connector_name") or config.get("connector_name") or ""
    )
    pair = str(executor.get("trading_pair") or config.get("trading_pair") or "")
    try:
        from condor.fetchers.trading_rules import fetch_trading_rules

        rules = await fetch_trading_rules(client, connector_name=connector, strict=True)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="Cannot check the child size step, so resume was not sent.",
        ) from exc
    rule = {}
    if isinstance(rules, dict):
        rule = rules.get(pair) or rules.get(pair.replace("-", "_")) or {}
    try:
        step = float((rule or {}).get("min_base_amount_increment") or 0)
    except (TypeError, ValueError):
        step = 0.0
    if step <= 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot check the child size step, so resume was not sent.",
        )
    for amount in amounts:
        steps = amount / step
        if abs(steps - round(steps)) > 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"A child order of {amount:g} is not a multiple of {step:g}, so resume was not sent.",
            )


@router.get("/servers/{name}/executors/positions")
async def get_positions_held(
    name: str,
    user: WebUser = Depends(require_server_access),
):
    cm = get_config_manager()

    client = await cm.get_client(name)
    try:
        result = await client.executors.get_positions_summary()
    except Exception as e:
        logger.exception("Failed to fetch held positions for server %s", name)
        raise upstream_error("Failed to fetch positions", e)

    # Normalize: extract positions list from various shapes
    if isinstance(result, dict):
        positions = result.get("positions", [])
        if not isinstance(positions, list):
            positions = [positions] if positions else []
    elif isinstance(result, list):
        positions = result
    else:
        positions = []

    return {
        "positions": positions,
        "summary": result if isinstance(result, dict) else {},
    }


@router.delete("/servers/{name}/executors/positions/{connector}/{pair}")
async def clear_position_held(
    name: str,
    connector: str,
    pair: str,
    controller_id: str = Query(default=""),
    user: WebUser = Depends(require_server_access),
):
    cm = get_config_manager()

    client = await cm.get_client(name)
    try:
        kwargs: dict = {}
        if controller_id:
            kwargs["controller_id"] = controller_id
        result = await client.executors.clear_position_held(
            connector_name=connector,
            trading_pair=pair,
            account_name="master_account",
            **kwargs,
        )
    except Exception as e:
        logger.exception("Failed to clear held position on server %s", name)
        raise upstream_error("Failed to clear position", e)
    record_ui_deed(
        user,
        verb="clear_position_held",
        summary=f"Clear held position {pair} on {connector}",
    )
    return {"status": "ok", "result": result}
