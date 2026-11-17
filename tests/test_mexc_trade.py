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
    # The exchange row is always kept. A tracked twin is shown only when the
    # amounts disagree, and the exchange row is the one named as such.
    from condor.web.routes.positions import rows_for_pane

    assert merge_venue_positions(tracked, venue) == added
    same = rows_for_pane(
        [
            {
                "connector_name": "mexc_perpetual",
                "trading_pair": "AIOT-USDT",
                "position_side": "LONG",
                "amount": 30,
                "source": "executor",
            }
        ],
        added,
    )
    assert len(same) == 1
    assert same[0]["source"] == "venue"
    both = rows_for_pane(
        [
            {
                "connector_name": "mexc_perpetual",
                "trading_pair": "AIOT-USDT",
                "position_side": "LONG",
                "amount": 10,
                "source": "executor",
            }
        ],
        added,
    )
    assert [row["source"] for row in both] == ["venue", "executor"]
    assert both[0]["amount"] == 30
    assert both[1]["amount"] == 10


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


def test_a_missing_position_read_aborts_and_a_default_margin_is_not_sent():
    trading = _Trading(margin_status=404)
    client = FakeClient()
    client.trading = trading
    with pytest.raises(Exception) as missing:
        asyncio.run(
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
    assert "Cannot read open positions" in str(missing.value)
    assert trading.leverage_calls == []
    assert trading.margin_calls == []

    async def get_positions(**_kwargs):
        return {"data": []}

    trading.get_positions = get_positions
    config = {
        "connector_name": "mexc_perpetual",
        "trading_pair": "AIOT-USDT",
        "leverage": 2,
        "margin_mode": "ISOLATED",
    }
    applied = asyncio.run(
        apply_venue_account_settings(client, "master_account", config)
    )
    assert applied is True
    assert trading.leverage_calls == []
    assert "margin_mode" not in config

    config["margin_mode"] = "CROSS"
    config["margin_explicit"] = True
    applied = asyncio.run(
        apply_venue_account_settings(client, "master_account", config)
    )
    assert applied is False
    assert "margin_mode" not in config
    assert trading.margin_calls
    assert trading.leverage_calls == []


def test_an_open_2x_position_is_not_moved_to_the_form_default():
    from condor.fetchers.account_settings import (
        AccountSettingsError,
        confirm_leverage,
    )

    trading = _Trading()
    pages = {"n": 0}

    async def get_positions(**kwargs):
        pages["n"] += 1
        if kwargs.get("cursor") != "page-2":
            filler = {
                "connector_name": "mexc_perpetual",
                "trading_pair": "OTHER-USDT",
                "side": "LONG",
                "amount": 1,
                "leverage": 9,
                "open_type": 1,
            }
            return {
                "data": [filler] * 200,
                "pagination": {"next_cursor": "page-2"},
            }
        return {
            "data": [
                {
                    "connector_name": "mexc_perpetual",
                    "trading_pair": "AIOT_USDT",
                    "side": "SHORT",
                    "amount": 1,
                    "leverage": 7,
                    "open_type": 2,
                },
                {
                    "connector_name": "mexc_perpetual",
                    "trading_pair": "AIOT_USDT",
                    "side": "LONG",
                    "amount": 60770,
                    "leverage": 2.0,
                    "open_type": 1,
                },
            ]
        }

    trading.get_positions = get_positions
    client = FakeClient()
    client.trading = trading
    config = {
        "connector_name": "mexc_perpetual",
        "trading_pair": "AIOT-USDT",
        "side": 1,
        "leverage": 1,
        "margin_mode": "ISOLATED",
        "leverage_explicit": True,
    }
    asyncio.run(apply_venue_account_settings(client, "master_account", config))
    assert pages["n"] == 2
    assert trading.leverage_calls == []
    assert config["leverage"] == 2
    assert "margin_mode" not in config

    config["leverage"] = 5
    config["leverage_explicit"] = True
    config["margin_mode"] = "CROSS"
    config["margin_explicit"] = True
    asyncio.run(apply_venue_account_settings(client, "master_account", config))
    assert trading.leverage_calls == []
    assert config["leverage"] == 2
    assert config["margin_mode"] == "CROSS"
    assert trading.margin_calls

    with pytest.raises(AccountSettingsError):
        asyncio.run(
            confirm_leverage(
                client, "master_account", "mexc_perpetual", "AIOT-USDT", 0, 1
            )
        )
    asyncio.run(
        confirm_leverage(client, "master_account", "mexc_perpetual", "AIOT-USDT", 2, 1)
    )
    assert trading.leverage_calls == []
    asyncio.run(
        confirm_leverage(client, "master_account", "mexc_perpetual", "AIOT-USDT", 5, 1)
    )
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


def test_creating_a_mexc_order_does_not_set_leverage_or_send_margin(monkeypatch):
    from fastapi import HTTPException

    trading = _Trading()

    async def get_positions(**_kwargs):
        return {"data": []}

    trading.get_positions = get_positions
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

    blind = _Trading()
    blind_client = FakeClient()
    blind_client.trading = blind
    monkeypatch.setattr(
        "condor.web.routes.executors.get_config_manager", lambda: _CM(blind_client)
    )
    with pytest.raises(HTTPException) as aborted:
        asyncio.run(
            create_executor_endpoint(
                name="srv",
                body=CreateExecutorRequest(
                    executor_type="order_executor",
                    config={
                        "connector_name": "mexc_perpetual",
                        "trading_pair": "AIOT-USDT",
                        "leverage": 2,
                        "amount": 20,
                    },
                ),
                user=_USER,
            )
        )
    assert aborted.value.status_code == 400

    monkeypatch.setattr(
        "condor.web.routes.executors.get_config_manager", lambda: _CM(client)
    )
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
    assert trading.leverage_calls == []

    with pytest.raises(HTTPException) as low:
        asyncio.run(
            create_executor_endpoint(
                name="srv",
                body=CreateExecutorRequest(
                    executor_type="order_executor",
                    config={
                        "connector_name": "mexc_perpetual",
                        "trading_pair": "AIOT-USDT",
                        "leverage": 0,
                        "amount": 20,
                    },
                ),
                user=_USER,
            )
        )
    assert low.value.status_code == 400
    assert "at least 1" in low.value.detail


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


def test_mark_notional_and_a_missing_leverage_stay_honest():
    added = merge_venue_positions(
        [],
        [
            {
                "connector_name": "mexc_perpetual",
                "trading_pair": "AIOT-USDT",
                "side": "LONG",
                "amount": 10,
                "entry_price": 0.08,
                "current_price": 0.1,
            }
        ],
    )
    assert added[0]["notional_value"] == 1
    assert added[0]["leverage"] is None
    kept = merge_venue_positions(
        [],
        [
            {
                "connector_name": "mexc_perpetual",
                "trading_pair": "AIOT-USDT",
                "side": "LONG",
                "amount": 10,
                "entry_price": 0.08,
                "leverage": 1,
            }
        ],
    )
    assert kept[0]["leverage"] == 1
    assert kept[0]["notional_value"] == 0.8


def test_a_live_row_without_margin_does_not_block_the_create():
    from condor.fetchers.account_settings import AccountSettingsError, confirm_leverage

    trading = _Trading()

    async def get_positions(**_kwargs):
        return {
            "data": [
                {
                    "connector_name": "mexc_perpetual",
                    "trading_pair": "AIOT_USDT",
                    "side": "PositionSide.LONG",
                    "amount": "60770",
                    "leverage": "2.0",
                }
            ]
        }

    trading.get_positions = get_positions
    client = FakeClient()
    client.trading = trading
    config = {
        "connector_name": "mexc_perpetual",
        "trading_pair": "AIOT-USDT",
        "side": 1,
        "leverage": 1,
        "margin_mode": "ISOLATED",
    }
    applied = asyncio.run(
        apply_venue_account_settings(client, "master_account", config)
    )
    assert applied is True
    assert config["leverage"] == 2
    assert "margin_mode" not in config
    assert trading.leverage_calls == []
    assert trading.margin_calls == []

    config["margin_mode"] = "CROSS"
    config["margin_explicit"] = True
    with pytest.raises(AccountSettingsError) as caught:
        asyncio.run(apply_venue_account_settings(client, "master_account", config))
    assert "margin mode" in str(caught.value)

    asyncio.run(
        confirm_leverage(client, "master_account", "mexc_perpetual", "AIOT-USDT", 2, 1)
    )
    assert trading.leverage_calls == []


def test_a_failed_position_read_is_not_treated_as_flat():
    from condor.fetchers.account_settings import AccountSettingsError

    trading = _Trading()

    async def get_positions(**_kwargs):
        raise RuntimeError("timeout")

    trading.get_positions = get_positions
    client = FakeClient()
    client.trading = trading
    with pytest.raises(AccountSettingsError):
        asyncio.run(
            apply_venue_account_settings(
                client,
                "master_account",
                {
                    "connector_name": "mexc_perpetual",
                    "trading_pair": "AIOT-USDT",
                    "leverage": 2,
                },
            )
        )


def test_cancel_prefers_the_client_order_id_and_the_fetched_account():
    from condor.web.routes.orders import cancel_identity

    account, order_id = cancel_identity(
        {
            "id": "bare",
            "order_id": "oid",
            "exchange_order_id": "ex",
            "client_order_id": "cid",
            "account_name": "sub",
        }
    )
    assert (account, order_id) == ("sub", "cid")
    account, order_id = cancel_identity(
        {"id": "bare", "exchange_order_id": "ex", "account": "desk"}
    )
    assert (account, order_id) == ("desk", "ex")
    underscored = normalize_order(
        {"client_order_id": "cid", "trading_pair": "AIOT_USDT", "account_name": "sub"}
    )
    assert underscored["trading_pair"] == "AIOT-USDT"
    assert underscored["account_name"] == "sub"


def test_order_envelopes_and_order_type_names():
    from condor.fetchers.orders import _extract_orders
    from condor.web.routes.market import canonical_order_type

    row = {"client_order_id": "cid"}
    assert _extract_orders([row]) == [row]
    assert _extract_orders({"orders": [row]}) == [row]
    assert _extract_orders({"data": [row]}) == [row]
    assert canonical_order_type("OrderType.LIMIT") == "LIMIT"
    assert canonical_order_type(1) == "MARKET"
    assert canonical_order_type(2) == "LIMIT"
    assert canonical_order_type(3) == "LIMIT_MAKER"


def test_stop_refuses_to_sell_more_than_the_executor_filled(monkeypatch):
    from fastapi import HTTPException

    from condor.web.routes.executors import stop_executor_endpoint

    stopped = []

    class _Executors:
        async def get_executor(self, executor_id):
            return {
                "connector_name": "mexc_perpetual",
                "trading_pair": "AIOT-USDT",
                "custom_info": {"filled_amount": 20},
                "config": {},
            }

        async def stop_executor(self, executor_id, keep_position=False):
            stopped.append((executor_id, keep_position))
            return {"ok": True}

    class _Trading:
        async def get_positions(self, **_kwargs):
            return {
                "data": [
                    {
                        "connector_name": "mexc_perpetual",
                        "trading_pair": "AIOT-USDT",
                        "side": "LONG",
                        "amount": 60770,
                    }
                ]
            }

    client = FakeClient()
    client.executors = _Executors()
    client.trading = _Trading()
    monkeypatch.setattr(
        "condor.web.routes.executors.get_config_manager", lambda: _CM(client)
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(
            stop_executor_endpoint(
                name="srv", executor_id="ex-1", keep_position=False, user=_USER
            )
        )
    assert caught.value.status_code == 400
    assert "60770" in caught.value.detail
    assert "20" in caught.value.detail
    assert stopped == []
    asyncio.run(
        stop_executor_endpoint(
            name="srv", executor_id="ex-1", keep_position=True, user=_USER
        )
    )
    assert stopped == [("ex-1", True)]


def test_resume_refuses_an_offstep_child(monkeypatch):
    from fastapi import HTTPException

    from condor.web.routes.executors import resume_executor_endpoint

    resumed = []

    class _Executors:
        def __init__(self, amount):
            self.amount = amount

        async def get_executor(self, executor_id):
            return {
                "connector_name": "mexc_perpetual",
                "trading_pair": "AIOT-USDT",
                "custom_info": {"levels": [{"amount": self.amount, "order_id": "c1"}]},
            }

        async def resume_executor(self, executor_id):
            resumed.append(executor_id)
            return {"ok": True}

    class _Connectors:
        async def get_trading_rules(self, connector_name):
            return {"AIOT-USDT": {"min_base_amount_increment": 10}}

    client = FakeClient()
    client.executors = _Executors(6077)
    client.connectors = _Connectors()
    monkeypatch.setattr(
        "condor.web.routes.executors.get_config_manager", lambda: _CM(client)
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(
            resume_executor_endpoint(name="srv", executor_id="ex-1", user=_USER)
        )
    assert caught.value.status_code == 400
    assert resumed == []

    client.executors = _Executors(6080)
    asyncio.run(resume_executor_endpoint(name="srv", executor_id="ex-1", user=_USER))
    assert resumed == ["ex-1"]

    client.executors = _Executors(0)
    with pytest.raises(HTTPException) as unread:
        asyncio.run(
            resume_executor_endpoint(name="srv", executor_id="ex-1", user=_USER)
        )
    assert unread.value.status_code == 400
    assert "child" in unread.value.detail
    assert resumed == ["ex-1"]


def test_an_unread_leverage_is_not_left_in_the_config():
    from condor.fetchers.account_settings import AccountSettingsError

    trading = _Trading()

    async def get_positions(**_kwargs):
        return {
            "data": [
                {
                    "connector_name": "mexc_perpetual",
                    "trading_pair": "AIOT-USDT",
                    "side": "LONG",
                    "amount": 60770,
                }
            ]
        }

    trading.get_positions = get_positions
    client = FakeClient()
    client.trading = trading
    with pytest.raises(AccountSettingsError) as caught:
        asyncio.run(
            apply_venue_account_settings(
                client,
                "master_account",
                {
                    "connector_name": "mexc_perpetual",
                    "trading_pair": "AIOT-USDT",
                    "side": 1,
                    "leverage": 10,
                },
            )
        )
    assert "leverage" in str(caught.value)
    assert trading.leverage_calls == []


def test_range_iceberg_is_refused_until_margin_can_be_omitted(monkeypatch):
    from fastapi import HTTPException

    client = FakeClient(result={"executor_id": "ex-ice"})
    called = {"n": 0}

    async def _create(*_args, **_kwargs):
        called["n"] += 1
        return {"executor_id": "ex-ice"}

    monkeypatch.setattr(
        "condor.web.routes.executors.get_config_manager", lambda: _CM(client)
    )
    monkeypatch.setattr("condor.fetchers.executors.create_executor", _create)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(
            create_executor_endpoint(
                name="srv",
                body=CreateExecutorRequest(
                    executor_type="range_iceberg_executor",
                    config={
                        "connector_name": "mexc_perpetual",
                        "trading_pair": "AIOT-USDT",
                        "leverage": 2,
                        "total_amount": 100,
                    },
                ),
                user=_USER,
            )
        )
    assert caught.value.status_code == 400
    assert "isolated" in caught.value.detail.lower()
    assert called["n"] == 0


def test_a_connector_mismatch_aborts_the_create_instead_of_looking_flat():
    from condor.fetchers.account_settings import AccountSettingsError

    trading = _Trading()

    async def get_positions(**_kwargs):
        return {
            "data": [
                {
                    "connector_name": "binance_perpetual",
                    "trading_pair": "AIOT-USDT",
                    "side": "LONG",
                    "amount": 60770,
                    "leverage": 2,
                }
            ]
        }

    trading.get_positions = get_positions
    client = FakeClient()
    client.trading = trading
    with pytest.raises(AccountSettingsError) as caught:
        asyncio.run(
            apply_venue_account_settings(
                client,
                "master_account",
                {
                    "connector_name": "mexc_perpetual",
                    "trading_pair": "AIOT-USDT",
                    "side": 1,
                    "leverage": 10,
                },
            )
        )
    assert "connector" in str(caught.value).lower()
    assert trading.leverage_calls == []


def test_the_trade_screen_does_not_set_leverage_on_open():
    from handlers.cex.trade import (
        apply_confirmed_leverage,
        load_position_mode,
        pair_leverage_status,
    )

    class _Screen:
        def __init__(self):
            self.calls = []

        async def get_position_mode(self, **_kwargs):
            return {"position_mode": "ONEWAY"}

        async def get_positions(self, **_kwargs):
            return {
                "data": [
                    {
                        "connector_name": "mexc_perpetual",
                        "trading_pair": "AIOT-USDT",
                        "amount": 60770,
                        "leverage": 2,
                    }
                ]
            }

        async def set_leverage(self, **kwargs):
            self.calls.append(kwargs)

    trading = _Screen()
    client = FakeClient()
    client.trading = trading
    cache = {}
    mode = asyncio.run(
        load_position_mode(client, "master", "mexc_perpetual", "AIOT-USDT", cache)
    )
    assert mode == "ONEWAY"
    assert cache["leverage_mexc_perpetual_AIOT-USDT"] == 2
    assert trading.calls == []

    sent = asyncio.run(
        apply_confirmed_leverage(
            client, "master", "mexc_perpetual", "AIOT-USDT", 2, "known", 2
        )
    )
    assert sent is False
    assert trading.calls == []
    sent = asyncio.run(
        apply_confirmed_leverage(
            client, "master", "mexc_perpetual", "AIOT-USDT", 5, "known", 2
        )
    )
    assert sent is True
    assert trading.calls[0]["leverage"] == 5
    status, _value = pair_leverage_status(
        [{"trading_pair": "AIOT-USDT", "amount": 60770}], "AIOT-USDT"
    )
    assert status == "unread"


def test_a_filled_mark_replaces_entry_notional():
    from condor.web.routes.positions import apply_mark_notional

    row = {"amount": 60770, "entry_price": 0.08137, "notional_value": 60770 * 0.08137}
    apply_mark_notional(row, 0.09)
    assert row["current_price"] == 0.09
    assert row["notional_value"] == 60770 * 0.09
