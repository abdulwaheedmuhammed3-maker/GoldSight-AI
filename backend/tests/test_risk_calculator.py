import pytest
from app.risk_calculator import calculate_position_size


def test_xauusd_usd_account_calculates_and_rounds_down():
    result = calculate_position_size(
        symbol="XAUUSD", side="BUY", balance=1000, risk_pct=1,
        entry=4200, stop_loss=4195, leverage=200, contract_size=100,
    )
    assert result["recommended_lot"] == 0.02
    assert result["estimated_loss"] == 10
    assert result["estimated_margin"] == 42


def test_ngn_account_uses_quote_conversion_rate():
    result = calculate_position_size(
        symbol="XAUUSD", side="SELL", balance=100000, risk_pct=1,
        entry=4200, stop_loss=4205, leverage=200, contract_size=100,
        quote_to_account_rate=1500,
    )
    assert result["status"] == "BELOW_MINIMUM_VOLUME"
    assert result["recommended_lot"] == 0
    assert result["estimated_loss_at_minimum_lot"] == 7500


def test_minimum_lot_that_breaks_risk_is_rejected():
    result = calculate_position_size(
        symbol="XAUUSD", side="BUY", balance=1000, risk_pct=1,
        entry=4200, stop_loss=4180, leverage=200, contract_size=100,
        min_volume=0.01, volume_step=0.01,
    )
    assert result["status"] == "BELOW_MINIMUM_VOLUME"
    assert result["recommended_lot"] == 0
    assert result["estimated_loss_at_minimum_lot"] == 20


def test_risk_cap_and_stop_direction_are_validated():
    common = dict(symbol="XAUUSD", side="BUY", balance=1000, entry=4200,
                  stop_loss=4190, leverage=200, contract_size=100)
    with pytest.raises(ValueError):
        calculate_position_size(**common, risk_pct=6)
    with pytest.raises(ValueError):
        calculate_position_size(**{**common, "stop_loss": 4210}, risk_pct=1)

def test_ngn_account_returns_safe_exness_minimum_lot_when_stop_is_narrow():
    result = calculate_position_size(
        symbol="XAUUSD", side="BUY", balance=100000, risk_pct=1,
        entry=4200, stop_loss=4199.5, leverage=200, contract_size=100,
        quote_to_account_rate=1500, volume_step=0.01, min_volume=0.01,
        max_volume=1000, margin_per_lot_quote=398.01,
    )
    assert result["status"] == "OK"
    assert result["recommended_lot"] == 0.01
    assert result["risk_budget"] == 1000
    assert result["estimated_loss"] == 750
    assert result["estimated_margin"] == 5970.15


def test_ngn_account_does_not_round_lot_size_up():
    result = calculate_position_size(
        symbol="XAUUSD", side="BUY", balance=100000, risk_pct=1,
        entry=4200, stop_loss=4199.2, leverage=200, contract_size=100,
        quote_to_account_rate=1500, volume_step=0.01, min_volume=0.01,
    )
    assert result["status"] == "BELOW_MINIMUM_VOLUME"
    assert result["recommended_lot"] == 0


@pytest.mark.parametrize("symbol", ["EURUSD", "GBPUSD"])
def test_major_fx_symbols_support_ngn_position_sizing(symbol):
    result = calculate_position_size(
        symbol=symbol, side="BUY", balance=300000, risk_pct=1,
        entry=1.1000, stop_loss=1.0990, leverage=200,
        contract_size=100000, quote_to_account_rate=1500,
    )
    assert result["status"] == "OK"
    assert result["recommended_lot"] == 0.02
    assert result["estimated_loss"] == 3000

def test_btcusd_exness_standard_contract_uses_broker_margin_not_leverage():
    result = calculate_position_size(
        symbol="BTCUSD", side="BUY", balance=300000, risk_pct=1,
        entry=100000, stop_loss=99900, leverage=200, contract_size=1,
        quote_to_account_rate=1500, volume_step=0.01, min_volume=0.01,
        max_volume=1000, margin_per_lot_quote=500,
    )
    assert result["status"] == "OK"
    assert result["recommended_lot"] == 0.01
    assert result["estimated_loss"] == 1500
    assert result["estimated_margin"] == 7500
