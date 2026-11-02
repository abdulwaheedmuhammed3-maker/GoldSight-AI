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
    migration_start = code.index("# Upgrade a legacy")
    migration_end = code.index("        conn.commit()", migration_start)
    migration = code[migration_start:migration_end]
    assert "WHERE status IN ('OPEN','CLOSED')" in migration
    assert "NOT EXISTS" in migration
    assert "AND starting_balance=100000" in migration


def test_demo_margin_guard_preserves_half_of_equity() -> None:
    from app.demo_trading import _has_margin_capacity

    assert _has_margin_capacity(300000, 90000, 60000)
    assert not _has_margin_capacity(300000, 90000, 60001)
    assert not _has_margin_capacity(300000, 150000, 1)
    assert not _has_margin_capacity(300000, -1, 1)
    assert not _has_margin_capacity(0, 0, 0)


def test_demo_signal_must_match_exact_latest_completed_candle() -> None:
    from app.demo_trading import _signal_matches_latest_bar

    assert _signal_matches_latest_bar("2026-10-30T16:15:00+00:00", 1793376900) is True
    assert _signal_matches_latest_bar("2026-10-30T16:00:00+00:00", 1793376900) is False
    assert _signal_matches_latest_bar("not-a-timestamp", 1793376900) is False
    assert _signal_matches_latest_bar(None, 1793376900) is False


def test_demo_trade_levels_must_be_finite_and_directionally_valid() -> None:
    from app.demo_trading import _valid_trade_levels

    assert _valid_trade_levels("BUY", 100, 95, 110)
    assert _valid_trade_levels("SELL", 100, 105, 90)
    assert not _valid_trade_levels("BUY", 100, 105, 110)
    assert not _valid_trade_levels("SELL", 100, 95, 90)
    assert not _valid_trade_levels("BUY", 100, 95, 95)
    assert not _valid_trade_levels("BUY", float("nan"), 95, 110)


def test_demo_account_uses_fixed_user_selected_volume_per_instrument() -> None:
    from app.demo_trading import DEMO_FIXED_LOTS

    assert DEMO_FIXED_LOTS == {
        "XAUUSD": 0.01,
        "BTCUSD": 0.03,
        "EURUSD": 0.08,
        "GBPUSD": 0.08,
    }


def test_demo_margin_guard_rejects_boolean_inputs() -> None:
    from app.demo_trading import _has_margin_capacity

    assert not _has_margin_capacity(True, 0, 0)
    assert not _has_margin_capacity(300000, False, 1)
    assert not _has_margin_capacity(300000, 0, True)



def test_account_row_lock_is_opt_in_and_uses_for_update() -> None:
    from app.demo_trading import _account

    class FakeResult:
        def fetchone(self):
            return {"id": 1, "balance": 300000.0}

    class FakeConnection:
        def __init__(self):
            self.queries = []

        def execute(self, query):
            self.queries.append(query)
            return FakeResult()

    conn = FakeConnection()
    _account(conn)
    assert "FOR UPDATE" not in conn.queries[-1]
    _account(conn, for_update=True)
    assert conn.queries[-1].endswith("FOR UPDATE")
