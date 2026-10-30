from app.demo_trading import RISK_FRACTION, MAX_OPEN_TRADES, STARTING_BALANCE


def test_demo_account_uses_conservative_one_percent_risk() -> None:
    assert RISK_FRACTION == 0.01
    assert MAX_OPEN_TRADES == 3


def test_demo_account_uses_nigerian_retail_starting_balance() -> None:
    assert STARTING_BALANCE == 300_000.0


def test_legacy_balance_migration_ignores_reset_only_trade_history() -> None:
    # RESET rows are audit history, not active/settled trades; they should
    # not block the one-time upgrade from the old ₦100,000 account.
    from pathlib import Path

    source = Path(__file__).parents[1] / "app" / "demo_trading.py"
    code = source.read_text(encoding="utf-8")
    migration = code.split("UPDATE goldsight_demo_account", 2)[-1]
    assert "WHERE status IN ('OPEN','CLOSED')" in migration
    assert "NOT EXISTS" in migration
    assert "AND starting_balance=100000" in migration
