"""Trading facts for venues the trade page has to treat differently from a name.

A connector whose name contains ``perpetual`` is a perp to every existing gate,
and ``mexc_perpetual`` already passes those. What the name does not say is the
rest of the contract: which margin modes the order form may offer, which order
types the venue actually accepts, and whether creating an order has to set
leverage on the account first. Those are recorded here, for the connectors
whose behavior was read off their Hummingbot source, and looked up by name.
Anything absent keeps the generic name check.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TradingProfile:
    """What the trade page may assume about one connector.

    ``confirms_account_settings`` means a plain limit or market order does not
    carry leverage or margin onto the exchange by itself, so Condor has to set
    them on the account before the executor is created. Range iceberg does
    that itself; the flag still applies so a limit order on the same venue
    uses the leverage the form shows.
    """

    perpetual: bool
    leverage: bool
    margin_modes: tuple[str, ...]
    position_modes: tuple[str, ...]
    order_types: tuple[str, ...]
    reduce_only: bool
    range_iceberg: bool
    confirms_account_settings: bool = False


# Order types and position modes are the connector's ``supported_order_types``
# and ``supported_position_modes``. MEXC's live trading rules report limit and
# market; the connector also accepts a post-only limit (``LIMIT_MAKER``). The
# form offers the live pair, and this profile is the fallback when a pair has
# not reported its own types yet. Both one-way and hedge are supported; the
# connector reads the account's mode from the exchange and will not trade
# until that read succeeds, so the form does not try to set it.
MEXC_PERPETUAL = TradingProfile(
    perpetual=True,
    leverage=True,
    margin_modes=("ISOLATED", "CROSS"),
    position_modes=("ONEWAY", "HEDGE"),
    order_types=("LIMIT", "MARKET", "LIMIT_MAKER"),
    reduce_only=True,
    range_iceberg=True,
    confirms_account_settings=True,
)

# Recorded so the shared perp check agrees with the name check these two
# already pass. Their margin modes are left empty: the order form must not
# grow a control that the stock trading API cannot apply.
BINANCE_PERPETUAL = TradingProfile(
    perpetual=True,
    leverage=True,
    margin_modes=(),
    position_modes=("HEDGE", "ONEWAY"),
    order_types=("LIMIT", "MARKET", "LIMIT_MAKER"),
    reduce_only=True,
    range_iceberg=False,
)

HYPERLIQUID_PERPETUAL = TradingProfile(
    perpetual=True,
    leverage=True,
    margin_modes=(),
    position_modes=("ONEWAY",),
    order_types=("LIMIT", "MARKET"),
    reduce_only=True,
    range_iceberg=False,
)

TRADING_PROFILES: dict[str, TradingProfile] = {
    "mexc_perpetual": MEXC_PERPETUAL,
    "binance_perpetual": BINANCE_PERPETUAL,
    "hyperliquid_perpetual": HYPERLIQUID_PERPETUAL,
}


def trading_profile(name: str) -> TradingProfile | None:
    """The recorded profile for ``name``, or ``None`` when it has none."""
    key = (name or "").strip()
    if not key:
        return None
    return TRADING_PROFILES.get(key) or TRADING_PROFILES.get(key.lower())


def is_perpetual_connector(name: str) -> bool:
    """Whether ``name`` is a perpetual venue.

    A recorded profile wins, so a perpetual registered under some other name
    still counts. Everything else keeps the historical name check (``perpetual``
    anywhere, or a ``_perp`` suffix). An empty name is not a perp: callers that
    treat "unknown" as a perp (the kill switch) decide that themselves.
    """
    profile = trading_profile(name)
    if profile is not None:
        return profile.perpetual
    lower = (name or "").strip().lower()
    if not lower:
        return False
    return "perpetual" in lower or lower.endswith("_perp")
