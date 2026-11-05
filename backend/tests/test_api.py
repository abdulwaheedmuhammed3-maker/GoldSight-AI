import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_root_identifies_service() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["name"] == "GoldSight AI API"


def test_health_endpoint_reports_provider_expectations() -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert "XAUUSD" in payload["providers"]
    assert "BTCUSD" in payload["providers"]


def test_only_supported_symbols_are_exposed() -> None:
    response = client.get("/api/v1/market/ETHUSD?timeframe=15m")
    assert response.status_code == 404


def test_invalid_timeframe_is_rejected() -> None:
    response = client.get("/api/v1/market/XAUUSD?timeframe=1m")
    assert response.status_code == 422


def test_offline_gold_never_returns_fabricated_price(monkeypatch) -> None:
    from app import main
    from app.market import MarketUnavailable

    def offline(*args, **kwargs):
        raise MarketUnavailable("provider disconnected")

    monkeypatch.setattr(main, "fetch_market", offline)
    monkeypatch.setattr(main, "xauusd_market_status", lambda: {"market_status": "OPEN", "market_phase": "TRADING", "next_open_at": None, "schedule_timezone": "UTC"})
    response = client.get("/api/v1/market/XAUUSD?timeframe=15m")
    assert response.status_code == 503
    payload = response.json()
    assert payload["status"] == "OFFLINE"
    assert payload["price"] is None
    assert payload["candles"] == []
    assert payload["signal"]["status"] == "NO SETUP"


def test_risk_profile_matches_demo_account_and_all_supported_symbols() -> None:
    response = client.get("/api/v1/risk/profile")
    assert response.status_code == 200
    payload = response.json()
    assert payload["account_currency"] == "NGN"
    assert payload["account_balance"] == 300000
    assert payload["default_risk_pct"] == 1
    assert set(payload["symbols"]) == {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD"}
    for symbol in ("EURUSD", "GBPUSD"):
        assert payload["symbols"][symbol]["contract_size"] == 100000
        assert payload["symbols"][symbol]["minimum_volume"] == 0.01
        assert payload["symbols"][symbol]["volume_step"] == 0.01


def test_exness_xauusd_market_hours_use_winter_schedule() -> None:
    from datetime import datetime, timezone
    from app.market_hours import xauusd_market_status

    closed = xauusd_market_status(datetime(2026, 11, 1, 17, 0, tzinfo=timezone.utc))
    assert closed["market_status"] == "MARKET_CLOSED"
    assert closed["market_phase"] == "WEEKEND"
    assert closed["next_open_at"] == "2026-11-01T22:05:00Z"

    daily_break = xauusd_market_status(datetime(2026, 11, 2, 22, 30, tzinfo=timezone.utc))
    assert daily_break["market_status"] == "MARKET_CLOSED"
    assert daily_break["market_phase"] == "DAILY_BREAK"
    assert daily_break["next_open_at"] == "2026-11-02T23:02:00Z"


def test_exness_xauusd_market_hours_use_summer_schedule() -> None:
    from datetime import datetime, timezone
    from app.market_hours import xauusd_market_status

    open_session = xauusd_market_status(datetime(2026, 7, 6, 19, 0, tzinfo=timezone.utc))
    assert open_session["market_status"] == "OPEN"
    assert open_session["next_open_at"] is None

    daily_break = xauusd_market_status(datetime(2026, 7, 6, 21, 30, tzinfo=timezone.utc))
    assert daily_break["market_status"] == "MARKET_CLOSED"
    assert daily_break["next_open_at"] == "2026-07-06T22:02:00Z"



@pytest.mark.parametrize("field,value", [
    ("balance", True),
    ("risk_pct", False),
    ("entry", True),
    ("stop_loss", False),
    ("leverage", True),
    ("contract_size", False),
    ("quote_to_account_rate", True),
    ("volume_step", False),
    ("min_volume", True),
    ("max_volume", False),
    ("margin_per_lot_quote", True),
])
def test_position_size_api_rejects_boolean_numeric_inputs(field, value) -> None:
    payload = {
        "symbol": "XAUUSD", "side": "BUY", "balance": 1000, "risk_pct": 1,
        "entry": 4200, "stop_loss": 4190, "leverage": 200, "contract_size": 100,
        "quote_to_account_rate": 1, "volume_step": 0.01, "min_volume": 0.01,
        "max_volume": 1000, "margin_per_lot_quote": 400,
    }
    payload[field] = value
    response = client.post("/api/v1/risk/position-size", json=payload)
    assert response.status_code == 422



def test_backtest_api_forwards_execution_cost_parameters(monkeypatch) -> None:
    from app import main

    captured = {}

    def fake_fetch_timeframe_market(symbol, timeframe, limit):
        return {"candles": [{"time": 1, "open": 100, "high": 101, "low": 99, "close": 100}], "spread": 0.25}

    def fake_run_backtest(candles, symbol, timeframe, spread, **kwargs):
        captured.update({
            "symbol": symbol,
            "timeframe": timeframe,
            "spread": spread,
            "commission_r": kwargs["commission_r"],
            "slippage_price": kwargs["slippage_price"],
        })
        return {"symbol": symbol, "timeframe": timeframe, "net_r_total": -0.75,
                "execution_cost_model": {"commission_r_per_round_trip": kwargs["commission_r"],
                                        "slippage_price_units_per_side": kwargs["slippage_price"]}}

    monkeypatch.setattr(main, "fetch_timeframe_market", fake_fetch_timeframe_market)
    monkeypatch.setattr(main, "run_backtest", fake_run_backtest)

    response = client.get(
        "/api/v1/backtest/XAUUSD?timeframe=4h&commission_r=0.15&slippage_price=0.4"
    )

    assert response.status_code == 200
    assert captured == {
        "symbol": "XAUUSD", "timeframe": "4h", "spread": 0.25,
        "commission_r": 0.15, "slippage_price": 0.4,
    }
    assert response.json()["execution_cost_model"]["commission_r_per_round_trip"] == 0.15
    assert response.json()["execution_cost_model"]["slippage_price_units_per_side"] == 0.4


@pytest.mark.parametrize(
    "query",
    ["commission_r=-0.01", "slippage_price=-0.01"],
)
def test_backtest_api_rejects_negative_execution_costs(query: str) -> None:
    response = client.get(f"/api/v1/backtest/XAUUSD?timeframe=4h&{query}")
    assert response.status_code == 422


def test_backtest_api_maps_backtest_cost_validation_to_422(monkeypatch) -> None:
    from app import main

    monkeypatch.setattr(
        main, "fetch_timeframe_market",
        lambda symbol, timeframe, limit: {"candles": [], "spread": 0.0},
    )

    def invalid_costs(*args, **kwargs):
        raise ValueError("slippage_price must be finite and nonnegative.")

    monkeypatch.setattr(main, "run_backtest", invalid_costs)
    response = client.get("/api/v1/backtest/XAUUSD?timeframe=4h&slippage_price=0.2")
    assert response.status_code == 422
    assert "finite and nonnegative" in response.json()["detail"]



def test_walk_forward_validation_api_forwards_costs_and_train_fraction(monkeypatch) -> None:
    from app import main

    captured = {}

    def fake_fetch_timeframe_market(symbol, timeframe, limit):
        return {"candles": [{"time": 1, "open": 100, "high": 101, "low": 99, "close": 100}], "spread": 0.25}

    def fake_validation(candles, symbol, timeframe, spread, **kwargs):
        captured.update({"symbol": symbol, "timeframe": timeframe, "spread": spread, **kwargs})
        return {"method": "Chronological holdout", "verdict": "INSUFFICIENT OOS SAMPLE"}

    monkeypatch.setattr(main, "fetch_timeframe_market", fake_fetch_timeframe_market)
    monkeypatch.setattr(main, "run_walk_forward_validation", fake_validation)

    response = client.get(
        "/api/v1/backtest/XAUUSD/validation?timeframe=4h&commission_r=0.1&slippage_price=0.2&train_fraction=0.65"
    )

    assert response.status_code == 200
    assert captured["symbol"] == "XAUUSD"
    assert captured["timeframe"] == "4h"
    assert captured["spread"] == 0.25
    assert captured["commission_r"] == 0.1
    assert captured["slippage_price"] == 0.2
    assert captured["train_fraction"] == 0.65
    assert response.json()["method"] == "Chronological holdout"


@pytest.mark.parametrize("query", ["train_fraction=0.4", "train_fraction=0.9"])
def test_walk_forward_validation_api_rejects_invalid_train_fraction(query: str) -> None:
    response = client.get(f"/api/v1/backtest/XAUUSD/validation?{query}")
    assert response.status_code == 422


def test_walk_forward_validation_api_rejects_unsupported_symbol() -> None:
    response = client.get("/api/v1/backtest/ETHUSD/validation")
    assert response.status_code == 404


def test_rolling_walk_forward_api_forwards_fold_parameters(monkeypatch) -> None:
    from app import main
    captured = {}

    monkeypatch.setattr(
        main, "fetch_timeframe_market",
        lambda symbol, timeframe, limit: {"candles": [{"time": 1}], "spread": 0.1},
    )

    def fake_validation(candles, symbol, timeframe, spread, **kwargs):
        captured.update({"symbol": symbol, "timeframe": timeframe, "spread": spread, **kwargs})
        return {"robustness_verdict": "INSUFFICIENT OOS SAMPLE"}

    monkeypatch.setattr(main, "run_rolling_walk_forward_folds", fake_validation)
    response = client.get(
        "/api/v1/backtest/XAUUSD/rolling-validation?timeframe=4h&folds=4&train_fraction=0.65&commission_r=0.1"
    )
    assert response.status_code == 200
    assert captured["symbol"] == "XAUUSD"
    assert captured["folds"] == 4
    assert captured["train_fraction"] == 0.65
    assert captured["commission_r"] == 0.1


@pytest.mark.parametrize("query", ["folds=1", "folds=6", "train_fraction=0.9"])
def test_rolling_walk_forward_api_rejects_invalid_parameters(query: str) -> None:
    response = client.get(f"/api/v1/backtest/XAUUSD/rolling-validation?{query}")
    assert response.status_code == 422
