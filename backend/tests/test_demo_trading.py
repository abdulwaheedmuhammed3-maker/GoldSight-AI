from app.demo_trading import RISK_FRACTION, MAX_OPEN_TRADES, STARTING_BALANCE


def test_demo_account_uses_conservative_one_percent_risk() -> None:
    assert RISK_FRACTION == 0.01
    assert MAX_OPEN_TRADES == 3


def test_demo_account_uses_nigerian_retail_starting_balance() -> None:
    assert STARTING_BALANCE == 300_000.0
