"""In-place range iceberg edits.

The trading API answers PATCH /executors/{id}/range-iceberg with a 200 object,
a 409 whose detail is itself an object, a 404 string, or a 422 list. The
proxy keeps those statuses and the toast reads the reason, not the object.
"""

import asyncio
from types import SimpleNamespace

from aiohttp import ClientResponseError, RequestInfo
from fastapi import HTTPException
from multidict import CIMultiDict
from yarl import URL

from condor.fetchers.executors import (
    api_error_text,
    describe_executor_error,
    update_range_iceberg,
)
from condor.fetchers.raw_api import detail
from condor.web.models import WebUser
from condor.web.routes.executors import edit_range_iceberg_endpoint

BACKEND = "http://10.0.0.7:8000/executors/ex-1/range-iceberg"
_USER = WebUser(id=1, role="admin")


def _info(status: int) -> RequestInfo:
    url = URL(BACKEND)
    return RequestInfo(url=url, method="PATCH", headers=CIMultiDict(), real_url=url)


def _api_error(status: int, detail) -> ClientResponseError:
    return ClientResponseError(
        _info(status),
        (),
        status=status,
        message=detail,
        headers=CIMultiDict(),
    )


class _Response:
    def __init__(self, status, body):
        self.status = status
        self._body = body
        self.request_info = _info(status)
        self.history = ()
        self.headers = CIMultiDict()

    @property
    def ok(self):
        return 200 <= self.status < 400

    async def json(self):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _Session:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def patch(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def _client(response):
    session = _Session(response)
    client = SimpleNamespace(
        bot_orchestration=SimpleNamespace(session=session, base_url="http://api:8000")
    )
    return client, session


def test_a_409_object_detail_is_the_reason():
    body = {
        "detail": {
            "accepted": False,
            "reason": "stop loss is closing",
            "executor_id": "ex-1",
        }
    }
    assert api_error_text(body) == "stop loss is closing"

    status, message = describe_executor_error(
        _api_error(409, body["detail"])
    )
    assert status == 409
    assert message == "stop loss is closing"
    assert "accepted" not in message
    assert "10.0.0.7" not in message


def test_a_stringified_409_object_is_still_the_reason():
    raw = "{'accepted': False, 'reason': 'shrink below filled', 'executor_id': 'ex-1'}"
    status, message = describe_executor_error(_api_error(409, raw))
    assert status == 409
    assert message == "shrink below filled"


def test_a_422_names_the_unknown_field_and_keeps_its_status():
    body = {
        "detail": [
            {
                "type": "extra_forbidden",
                "loc": ["body", "cap_behavior"],
                "msg": "Extra inputs are not permitted",
                "input": "WAIT",
            }
        ]
    }
    assert api_error_text(body) == "cap_behavior: Extra inputs are not permitted"
    status, message = describe_executor_error(_api_error(422, body["detail"]))
    assert status == 422
    assert message == "cap_behavior: Extra inputs are not permitted"


def test_a_plain_message_field_is_still_the_sentence():
    text = asyncio.run(detail(_Response(400, {"message": "Gateway is already running."})))
    assert text == "Gateway is already running."


def test_a_404_string_is_unchanged():
    text = "Executor ex-1 is not a range iceberg"
    status, message = describe_executor_error(_api_error(404, text))
    assert status == 404
    assert message == text


def test_an_already_open_refusal_is_the_api_text():
    text = (
        "A range iceberg is already open on AIOT-USDT BUY for master_account "
        "(executor abc). Close it first."
    )
    _status, message = describe_executor_error(_api_error(409, text))
    assert message == text


def test_update_forwards_null_and_a_decimal_string():
    client, session = _client(
        _Response(200, {"accepted": True, "reason": "", "executor_id": "ex/1"})
    )
    result = asyncio.run(
        update_range_iceberg(
            client,
            "ex/1",
            {"total_amount": "12.5", "stop_loss": None},
        )
    )
    assert result["accepted"] is True
    url, kwargs = session.calls[0]
    assert url.endswith("/executors/ex%2F1/range-iceberg")
    assert kwargs["json"] == {"total_amount": "12.5", "stop_loss": None}


def test_update_surfaces_the_409_reason_from_the_body():
    client, _session = _client(
        _Response(
            409,
            {
                "detail": {
                    "accepted": False,
                    "reason": "parked POSITION_HOLD",
                    "executor_id": "ex-1",
                }
            },
        )
    )
    try:
        asyncio.run(update_range_iceberg(client, "ex-1", {"total_amount": 1}))
    except ClientResponseError as exc:
        status, message = describe_executor_error(exc)
    else:
        raise AssertionError("the rejection must raise")
    assert status == 409
    assert message == "parked POSITION_HOLD"
    assert "10.0.0.7" not in message


class _CM:
    def __init__(self, client):
        self._client = client

    async def get_client(self, _name):
        return self._client


def test_the_route_keeps_409_and_422(monkeypatch):
    async def reject(_client, _executor_id, _body):
        raise _api_error(
            409,
            {
                "accepted": False,
                "reason": "stop on the wrong side",
                "executor_id": "ex-1",
            },
        )

    monkeypatch.setattr(
        "condor.fetchers.executors.update_range_iceberg", reject
    )
    monkeypatch.setattr(
        "condor.web.routes.executors.get_config_manager",
        lambda: _CM(SimpleNamespace()),
    )
    try:
        asyncio.run(
            edit_range_iceberg_endpoint(
                "srv", "ex-1", {"total_amount": 1}, _USER
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail == "stop on the wrong side"
    else:
        raise AssertionError("409 must stay 409")

    async def invalid(_client, _executor_id, _body):
        raise _api_error(
            422,
            [
                {
                    "loc": ["body", "nope"],
                    "msg": "Extra inputs are not permitted",
                }
            ],
        )

    monkeypatch.setattr(
        "condor.fetchers.executors.update_range_iceberg", invalid
    )
    try:
        asyncio.run(
            edit_range_iceberg_endpoint("srv", "ex-1", {"nope": 1}, _USER)
        )
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail == "nope: Extra inputs are not permitted"
    else:
        raise AssertionError("422 must stay 422")
