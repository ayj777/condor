"""MEXC trade-page support that is not a name check.

Credential errors name the exchange code, a venue position reaches the
positions payload, leverage is set before a MEXC order, and resume reports a
501 when this API has no such route.
"""

import asyncio

import pytest
from aiohttp import ClientResponseError

from condor.fetchers.account_settings import apply_venue_account_settings
from condor.fetchers.executors import clarify_exchange_error, describe_executor_error
from condor.web.models import CreateExecutorRequest, WebUser
from condor.web.routes.executors import (
    create_executor_endpoint,
    resume_executor_endpoint,
)
from condor.web.routes.orders import normalize_order
from condor.web.routes.positions import merge_venue_positions
from tests.test_executor_mutation_errors import FakeClient, _api_error


def test_a_mexc_402_is_named_and_a_plain_message_is_not():
    assert (
        clarify_exchange_error("Error: 402 - API Key expired", "mexc_perpetual")
        == "MEXC code 402: API Key expired"
    )
    assert clarify_exchange_error("insufficient balance", "mexc_perpetual") == (
        "insufficient balance"
    )
    assert clarify_exchange_error("executor 400-403-400 not found") == (
        "executor 400-403-400 not found"
    )
    embedded = "{'code': 402, 'msg': 'API Key expired'}"
    assert clarify_exchange_error(embedded, "mexc_perpetual") == (
        "MEXC code 402: API Key expired"
    )


def test_describe_keeps_the_status_and_rewrites_the_message():
    status, message = describe_executor_error(
        _api_error(400, "Error: 402 - API Key expired"),
        connector="mexc_perpetual",
    )
    assert status == 400
    assert message == "MEXC code 402: API Key expired"


def test_a_dict_detail_is_still_rewritten():
    exc = ClientResponseError(
        request_info=None,  # type: ignore[arg-type]
        history=(),
        status=400,
        message={"code": 402, "message": "API Key expired"},  # type: ignore[arg-type]
    )
    status, message = describe_executor_error(exc, connector="mexc_perpetual")
    assert status == 400
    assert message == "MEXC code 402: API Key expired"


def test_a_live_mexc_position_is_added_and_a_tracked_one_is_not_doubled():
    venue = [
        {
            "account_name": "master_account",
            "connector_name": "mexc_perpetual",
            "trading_pair": "AIOT-USDT",
            "side": "LONG",
            "amount": "30",
            "entry_price": "0.08",
            "unrealized_pnl": "1.5",
            "leverage": 2.0,
        }
    ]
    added = merge_venue_positions([], venue)
    assert len(added) == 1
    row = added[0]
    assert row["connector_name"] == "mexc_perpetual"
    assert row["trading_pair"] == "AIOT-USDT"
    assert row["position_side"] == "LONG"
    assert row["amount"] == 30
    assert row["entry_price"] == 0.08
    assert row["unrealized_pnl"] == 1.5
    assert row["leverage"] == 2
    assert row["source"] == "venue"

    tracked = [
        {
            "connector_name": "mexc_perpetual",
            "trading_pair": "AIOT-USDT",
            "position_side": "BUY",
        }
    ]
    assert merge_venue_positions(tracked, venue) == []


def test_a_flat_venue_row_is_dropped():
    assert (
        merge_venue_positions([], [{"connector_name": "mexc_perpetual", "amount": 0}])
        == []
    )


def test_the_live_aiot_long_survives_pair_spelling_and_a_flat_tracked_row():
    # The shape GET/POST /trading/positions actually returns for this account:
    # 60,770 AIOT at 2x. The exchange symbol uses an underscore, the side is a
    # Python enum string, and the numbers arrive as strings.
    venue = [
        {
            "account_name": "master_account",
            "connector_name": "mexc_perpetual",
            "trading_pair": "AIOT_USDT",
            "side": "PositionSide.LONG",
            "amount": "60770",
            "entry_price": "0.08137",
            "unrealized_pnl": "12.5",
            "leverage": "2.0",
        }
    ]
    added = merge_venue_positions(
        [
            {
                "connector_name": "mexc_perpetual",
                "trading_pair": "AIOT-USDT",
                "position_side": "LONG",
                "amount": 0,
            }
        ],
        venue,
    )
    assert len(added) == 1
    row = added[0]
    assert row["connector_name"] == "mexc_perpetual"
    assert row["trading_pair"] == "AIOT-USDT"
    assert row["position_side"] == "LONG"
    assert row["amount"] == 60770
    assert row["leverage"] == 2
    assert row["source"] == "venue"
    assert row["controller_id"] == ""


def test_position_rows_come_out_of_a_list_or_an_envelope():
    from condor.fetchers.positions import _extract_positions

    row = {"trading_pair": "AIOT-USDT", "amount": 60770}
    assert _extract_positions([row]) == [row]
    assert _extract_positions({"data": [row]}) == [row]
    assert _extract_positions({"positions": [row]}) == [row]
    assert _extract_positions({"ok": True}) == []


class _Trading:
    def __init__(self, margin_status=None):
        self.leverage_calls = []
        self.margin_calls = []
        self.margin_status = margin_status

    async def set_leverage(self, account, connector, pair, leverage):
        self.leverage_calls.append((account, connector, pair, leverage))

    async def _post(self, path, json=None):
        self.margin_calls.append((path, json))
        if self.margin_status == 404:
            raise _api_error(404, "not found")
        return {"ok": True}


def test_mexc_sets_leverage_and_survives_a_missing_margin_route():
    trading = _Trading(margin_status=404)
    client = FakeClient()
    client.trading = trading
    applied = asyncio.run(
        apply_venue_account_settings(
            client,
            "master_account",
            {
                "connector_name": "mexc_perpetual",
                "trading_pair": "AIOT-USDT",
                "leverage": 2,
                "margin_mode": "ISOLATED",
            },
        )
    )
    assert applied is False
    assert trading.leverage_calls == [
        ("master_account", "mexc_perpetual", "AIOT-USDT", 2)
    ]
    assert trading.margin_calls


def test_an_open_2x_position_is_not_moved_to_the_form_default():
    trading = _Trading()

    async def get_positions(**_kwargs):
        return {
            "data": [
                {
                    "connector_name": "mexc_perpetual",
                    "trading_pair": "AIOT-USDT",
                    "side": "LONG",
                    "amount": 60770,
                    "leverage": 2.0,
                }
            ]
        }

    trading.get_positions = get_positions
    client = FakeClient()
    client.trading = trading
    config = {
        "connector_name": "mexc_perpetual",
        "trading_pair": "AIOT-USDT",
        "leverage": 1,
        "margin_mode": "ISOLATED",
        "leverage_explicit": False,
    }
    asyncio.run(apply_venue_account_settings(client, "master_account", config))
    assert trading.leverage_calls == []
    assert config["leverage"] == 2

    config["leverage"] = 5
    config["leverage_explicit"] = True
    asyncio.run(apply_venue_account_settings(client, "master_account", config))
    assert trading.leverage_calls == [
        ("master_account", "mexc_perpetual", "AIOT-USDT", 5)
    ]


def test_binance_does_not_set_leverage_on_create():
    trading = _Trading()
    client = FakeClient()
    client.trading = trading
    applied = asyncio.run(
        apply_venue_account_settings(
            client,
            "master_account",
            {
                "connector_name": "binance_perpetual",
                "trading_pair": "BTC-USDT",
                "leverage": 5,
                "margin_mode": "CROSS",
            },
        )
    )
    assert applied is None
    assert trading.leverage_calls == []


class _CM:
    def __init__(self, client):
        self._client = client

    def has_server_access(self, user_id, name, *a, **kw):
        return True

    async def get_client(self, name):
        return self._client


_USER = WebUser(id=1, role="admin")


def test_creating_a_mexc_order_sets_leverage_and_strips_margin_mode(monkeypatch):
    trading = _Trading()
    client = FakeClient(result={"executor_id": "ex-mexc"})
    client.trading = trading
    seen = {}

    async def _create(client, config, account_name="master_account"):
        seen["config"] = dict(config)
        seen["account"] = account_name
        return {"executor_id": "ex-mexc"}

    monkeypatch.setattr(
        "condor.web.routes.executors.get_config_manager", lambda: _CM(client)
    )
    # The route imports create_executor inside the function, so the patch has
    # to land on the module it imports from.
    monkeypatch.setattr("condor.fetchers.executors.create_executor", _create)

    result = asyncio.run(
        create_executor_endpoint(
            name="srv",
            body=CreateExecutorRequest(
                executor_type="order_executor",
                config={
                    "connector_name": "mexc_perpetual",
                    "trading_pair": "AIOT-USDT",
                    "leverage": 2,
                    "margin_mode": "CROSS",
                    "amount": 20,
                },
            ),
            user=_USER,
        )
    )

    assert result["status"] == "ok"
    assert result["executor_id"] == "ex-mexc"
    assert result["margin_mode_applied"] is True
    assert seen["config"]["leverage"] == 2
    assert "margin_mode" not in seen["config"]
    assert trading.leverage_calls == [
        ("master_account", "mexc_perpetual", "AIOT-USDT", 2)
    ]


def test_resume_404_is_a_501(monkeypatch):
    class _Executors:
        async def _post(self, path):
            raise _api_error(404, "not found")

    client = FakeClient()
    client.executors = _Executors()
    monkeypatch.setattr(
        "condor.web.routes.executors.get_config_manager", lambda: _CM(client)
    )

    with pytest.raises(Exception) as caught:
        asyncio.run(
            resume_executor_endpoint(name="srv", executor_id="ex-1", user=_USER)
        )
    assert caught.value.status_code == 501
    assert "does not support resuming" in caught.value.detail


def test_normalize_order_reads_either_spelling():
    row = normalize_order(
        {
            "clientOrderId": "abc",
            "tradingPair": "AIOT-USDT",
            "side": "BUY",
            "orderType": "LIMIT",
            "quantity": "10",
            "price": "0.08",
            "status": "OPEN",
        }
    )
    assert row["client_order_id"] == "abc"
    assert row["trading_pair"] == "AIOT-USDT"
    assert row["trade_type"] == "BUY"
    assert row["amount"] == 10
    assert row["price"] == 0.08
