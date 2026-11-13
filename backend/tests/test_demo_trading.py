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
        "EURGBP": 0.08,
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
    assert "auto_trade=TRUE" in reset


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
    assert "Estimated margin exceeds the 50% utilization cap." not in result["reason"]
    assert result["estimated_margin_ngn"] is None


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



def test_demo_signal_key_uses_canonical_utc_timestamp() -> None:
    from app.demo_trading import _demo_signal_key

    zulu = _demo_signal_key("XAUUSD", "5m", "BUY", "2026-11-12T20:30:00Z")
    offset = _demo_signal_key("XAUUSD", "5m", "BUY", "2026-11-12T21:30:00+01:00")

    assert zulu == offset
    assert zulu.endswith("2026-11-12T20:30:00+00:00")


def test_demo_entry_requires_exact_persisted_setup_levels() -> None:
    from app.demo_trading import _saved_setup_matches

    class FakeResult:
        def fetchone(self):
            return {"entry": 100.0, "stop_loss": 95.0, "take_profits": [110.0, 115.0]}

    class FakeConnection:
        def __init__(self):
            self.query = ""
            self.params = None

        def execute(self, query, params):
            self.query, self.params = query, params
            return FakeResult()

    conn = FakeConnection()
    assert _saved_setup_matches(conn, "key", "XAUUSD", "5m", "BUY", 100, 95, 110)
    assert not _saved_setup_matches(conn, "key", "XAUUSD", "5m", "BUY", 101, 95, 110)
    assert "goldsight_setup_history" in conn.query
    assert conn.params == ("key", "XAUUSD", "5m", "BUY")


def test_demo_entry_candidate_is_loaded_from_setup_history_not_scanner_signal() -> None:
    from pathlib import Path

    source = Path(__file__).parents[1] / "app" / "demo_trading.py"
    code = source.read_text(encoding="utf-8")
    process = code[code.index("def process_demo_market("):code.index("\ndef get_demo_account(")]
    assert 'market_data.get("signal")' not in process
    assert "FROM goldsight_setup_history h" in process
    assert "NOT EXISTS" in process
    assert 'saved_setup["entry"]' in process
    assert 'saved_setup["stop_loss"]' in process
    assert 'saved_setup["take_profits"]' in process
    assert 'saved_setup["id"]' in process
    assert "setup_id" in process


def test_demo_setup_selection_requires_exact_latest_completed_candle() -> None:
    from pathlib import Path

    source = Path(__file__).parents[1] / "app" / "demo_trading.py"
    code = source.read_text(encoding="utf-8")
    assert "EXTRACT(EPOCH FROM h.signal_time)::BIGINT=%s" in code
    assert "h.status='DETECTED'" in code
    assert "WHERE d.signal_key=h.signal_key" in code


def test_setup_history_persists_setup_identity_into_notification_payload() -> None:
    from pathlib import Path

    root = Path(__file__).parents[1] / "app"
    history = (root / "setup_history.py").read_text(encoding="utf-8")
    notifications = (root / "push_notifications.py").read_text(encoding="utf-8")
    assert "inserted_setup_id = int(inserted_row[0])" in history
    assert 'notification_signal["setup_id"] = inserted_setup_id' in history
    assert 'notification_signal["signal_key"] = key' in history
    assert '"setup_id": signal.get("setup_id")' in notifications
    assert '"signal_key": signal.get("signal_key")' in notifications


def test_demo_staged_tp_management_requires_strong_three_target_setup():
    from pathlib import Path

    source = Path(__file__).parents[1] / "app" / "demo_trading.py"
    code = source.read_text(encoding="utf-8")
    assert "bool(len(targets) >= 3)" in code
    assert "staged_management" in code
    assert "tp1_done" in code and "tp2_done" in code
    assert "original_lot * 0.50" in code
    assert "original_lot * 0.25" in code
    assert 'float(trade["entry"]) if tp1_done' in code
    assert "SL wins ties" in code


def test_demo_staged_tp_columns_are_added_safely_for_existing_accounts():
    from pathlib import Path

    source = Path(__file__).parents[1] / "app" / "demo_trading.py"
    code = source.read_text(encoding="utf-8")
    assert "ADD COLUMN IF NOT EXISTS tp1_done" in code
    assert "ADD COLUMN IF NOT EXISTS tp2_done" in code
    assert "ADD COLUMN IF NOT EXISTS partial_pnl" in code
    assert "ADD COLUMN IF NOT EXISTS staged_management" in code



def test_legacy_demo_trades_without_lot_size_keep_risk_based_pnl_fallback():
    from pathlib import Path

    source = Path(__file__).parents[1] / "app" / "demo_trading.py"
    code = source.read_text(encoding="utf-8")
    assert 'original_lot = float(trade.get("lot_size") or 1.0)' in code
    assert 'if trade.get("lot_size") and trade.get("contract_size")' in code


def test_open_staged_trade_partial_profit_is_in_realized_account_pnl():
    from pathlib import Path

    source = Path(__file__).parents[1] / "app" / "demo_trading.py"
    code = source.read_text(encoding="utf-8")
    totals = code[code.index("totals = conn.execute"):code.index('realized = float(totals["realized_pnl"]')]
    assert "SUM(pnl) FILTER (WHERE status='CLOSED')" in totals
    assert "SUM(partial_pnl) FILTER (WHERE status='OPEN')" in totals
