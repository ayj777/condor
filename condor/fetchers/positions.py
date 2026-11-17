"""Fetch position data from Hummingbot API."""

import logging
from functools import partial
from typing import Any, Dict, List, Optional

from condor.fetchers._pagination import collect_pages

logger = logging.getLogger(__name__)


class PositionBookError(Exception):
    """The server returned rows, and none of them were this connector."""


# Cap on how many positions a single walk accumulates (not on iterations:
# the walker's own empty-page and cursor-progress guards end a stalled walk).
MAX_POSITIONS_FETCH = 2000
POSITIONS_PAGE_SIZE = 200


def _keep_for_connector(
    rows: List[Dict[str, Any]], connector_name: str
) -> tuple[List[Dict[str, Any]], int]:
    """Rows the server already scoped to this connector.

    A missing ``connector_name`` is kept: the request already asked for this
    connector. A name that differs only by case is the same connector. A
    different name is dropped, and the dropped count tells the caller that an
    empty result is a filter mismatch rather than a flat account.
    """
    want = connector_name.strip().lower()
    kept: List[Dict[str, Any]] = []
    dropped = 0
    for row in rows:
        name = str(row.get("connector_name") or "").strip()
        if not name or name.lower() == want:
            kept.append(row)
        else:
            dropped += 1
    return kept, dropped


def _extract_positions(result: Any) -> List[Dict[str, Any]]:
    """Rows out of one ``get_positions`` page.

    The stock client returns ``{"data": [...]}``. A fork that answers with the
    list itself, or nests it under ``positions``, used to be read as an empty
    book, and the trade page then said the account was flat.
    """
    if isinstance(result, list):
        return [row for row in result if isinstance(row, dict)]
    if isinstance(result, dict):
        for key in ("data", "positions"):
            rows = result.get(key)
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
    return []


async def fetch_positions(
    client,
    connector_name: Optional[str] = None,
    limit: int = MAX_POSITIONS_FETCH,
    strict: bool = False,
    **_kw,
) -> List[Dict[str, Any]]:
    """Fetch open positions, optionally filtered by connector.

    When ``connector_name`` is given it is sent to the API as
    ``connector_names=[connector_name]``, so the filter is applied server-side
    (before any cap). The client-side filter is kept only as a defensive pass
    for servers that ignore the argument, and therefore runs *after* the cap.

    Walks the cursor in ``POSITIONS_PAGE_SIZE`` pages until exhausted or until
    ``limit`` rows are accumulated; reaching that cap truncates the result and
    logs a warning.

    Args:
        strict: Raise when the request itself fails, instead of reporting the
            account as flat. Callers that cache the answer want the distinction:
            an unreachable server is worth retrying, "no open positions" is not.
    """

    def _warn_truncated() -> None:
        logger.warning(
            "fetch_positions reached the %s-position safety cap; "
            "results are truncated",
            limit,
        )

    filters: Dict[str, Any] = (
        {"connector_names": [connector_name]} if connector_name else {}
    )
    try:
        positions: List[Dict[str, Any]] = await collect_pages(
            partial(client.trading.get_positions, **filters),
            _extract_positions,
            page_size=POSITIONS_PAGE_SIZE,
            max_items=limit,
            on_truncated=_warn_truncated,
        )

        if connector_name and positions:
            positions, dropped = _keep_for_connector(positions, connector_name)
            if not positions and dropped and strict:
                raise PositionBookError(
                    "Positions came back for a different connector, "
                    "so the order was not sent."
                )

        return positions

    except Exception as e:
        if strict:
            raise
        logger.error("Error fetching positions: %s", e, exc_info=True)
        return []
