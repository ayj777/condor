"""Recorded trading facts for mexc_perpetual, and the shared perp check."""

from condor.agents.shutdown import _is_perp
from condor.venue_capabilities import (
    is_perpetual_connector,
    perpetual_for_closeout,
    trading_profile,
)


def test_mexc_perpetual_profile_matches_the_connector():
    profile = trading_profile("mexc_perpetual")
    assert profile is not None
    assert profile.perpetual is True
    assert profile.leverage is True
    assert profile.margin_modes == ("ISOLATED", "CROSS")
    assert "ONEWAY" in profile.position_modes
    assert "HEDGE" in profile.position_modes
    assert "LIMIT" in profile.order_types
    assert "MARKET" in profile.order_types
    assert profile.reduce_only is True
    assert profile.range_iceberg is True
    assert profile.confirms_account_settings is True


def test_binance_and_hyperliquid_stay_perpetual_without_a_margin_control():
    # A margin dropdown on these venues would offer a setting the stock API
    # cannot apply. They stay perpetuals with leverage and no margin list.
    for name in ("binance_perpetual", "hyperliquid_perpetual"):
        profile = trading_profile(name)
        assert profile is not None
        assert profile.perpetual is True
        assert profile.leverage is True
        assert profile.margin_modes == ()
        assert profile.range_iceberg is False


def test_an_unlisted_perpetual_still_counts_and_spot_does_not():
    assert is_perpetual_connector("kucoin_perpetual") is True
    assert is_perpetual_connector("binance") is False
    assert is_perpetual_connector("") is False


def test_closeout_keeps_the_old_perpetual_substring():
    assert perpetual_for_closeout("mexc_perpetual") is True
    assert perpetual_for_closeout("kucoin_perpetual") is True
    assert perpetual_for_closeout("foo_perp") is False
    assert perpetual_for_closeout("Kucoin_Perpetual") is False
    assert is_perpetual_connector("foo_perp") is True
    assert is_perpetual_connector("kucoin_perpetual") is True


def test_shutdown_treats_mexc_as_a_perp_and_an_empty_name_as_unknown():
    assert _is_perp("mexc_perpetual") is True
    assert _is_perp("binance_perpetual") is True
    assert _is_perp("binance") is False
    assert _is_perp("") is True
