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
        "USDJPY": 0.08,
        "AUDUSD": 0.08,
        "USDCAD": 0.08,
        "USDCHF": 0.08,
        "NZDUSD": 0.08,
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



def test_global_demo_reset_deletes_trades_and_signal_history_before_balance_reset() -> None:
    from pathlib import Path

    source = Path(__file__).parents[1] / "app" / "demo_trading.py"
    code = source.read_text(encoding="utf-8")
    reset = code[code.index("def reset_demo_account()") :]
    lock = reset.index("SELECT id FROM goldsight_demo_account WHERE id=1 FOR UPDATE")
    history_lock = reset.index("LOCK TABLE goldsight_setup_history IN ACCESS EXCLUSIVE MODE")
    trade_delete = reset.index("DELETE FROM goldsight_demo_trades")
    history_delete = reset.index("DELETE FROM goldsight_setup_history")
    balance_update = reset.index("UPDATE goldsight_demo_account SET balance=")
    assert lock < history_lock < trade_delete < history_delete < balance_update
    assert "status='RESET'" not in reset


def test_demo_sizing_preview_reports_fixed_lot_risk_rejection(monkeypatch) -> None:
    from app.demo_trading import demo_sizing_preview

    monkeypatch.setattr("app.demo_trading._quote_to_ngn_demo_rate", lambda symbol: (1344.0, "BROKER_CONFIGURED"))
    result = demo_sizing_preview(
        symbol="EURUSD", side="BUY", entry=1.12195, stop_loss=1.12087225,
        balance=305901.77, used_margin=0.0,
    )
    assert result["status"] == "REJECTED"
    assert result["configured_lot"] == 0.08
    assert result["quote_to_ngn_rate"] == 1344.0
    assert result["quote_to_ngn_rate_source"] == "BROKER_CONFIGURED"
    assert result["risk_budget_ngn"] == 3059.02
    assert result["risk_budget_ok"] is False
    assert "1% budget" in result["reason"]


def test_demo_sizing_preview_passes_when_fixed_volume_within_risk_and_margin(monkeypatch) -> None:
    from app.demo_trading import demo_sizing_preview

    monkeypatch.setattr("app.demo_trading._quote_to_ngn_demo_rate", lambda symbol: (1344.0, "BROKER_CONFIGURED"))
    result = demo_sizing_preview(
        symbol="EURUSD", side="BUY", entry=1.12, stop_loss=1.1199,
        balance=305901.77, used_margin=0.0,
    )
    assert result["status"] == "PASS"
    assert result["configured_lot"] == 0.08
    assert result["recommended_lot"] == 0.08
    assert result["risk_budget_ok"] is True
    assert result["margin_capacity_ok"] is True


def test_demo_sizing_preview_rejects_wrong_stop_direction(monkeypatch) -> None:
    from app.demo_trading import demo_sizing_preview

    monkeypatch.setattr("app.demo_trading._quote_to_ngn_demo_rate", lambda symbol: (1344.0, "BROKER_CONFIGURED"))
    try:
        demo_sizing_preview(
            symbol="EURUSD", side="BUY", entry=1.12, stop_loss=1.121,
            balance=305901.77,
        )
    except ValueError as exc:
        assert "Stop-loss must be below entry" in str(exc)
    else:
        raise AssertionError("Invalid BUY stop-loss direction must be rejected.")
