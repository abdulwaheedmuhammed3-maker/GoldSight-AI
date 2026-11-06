import pytest

from app.setup_performance import summarize_setup_performance


def test_aggregates_terminal_tp_and_sl_outcomes_and_excludes_void_open():
    records = [
        {"symbol": "XAUUSD", "timeframe": "15m", "status": "TP1_HIT"},
        {"symbol": "XAUUSD", "timeframe": "15m", "status": "TP3_HIT"},
        {"symbol": "XAUUSD", "timeframe": "15m", "status": "SL_HIT"},
        {"symbol": "XAUUSD", "timeframe": "15m", "status": "VOID"},
        {"symbol": "XAUUSD", "timeframe": "15m", "status": "ACTIVE"},
    ]
    result = summarize_setup_performance(records)
    assert result["overall"] == {"wins": 2, "losses": 1, "void": 1, "resolved": 3, "win_rate_pct": 66.67}
    assert result["by_market"] == [{"symbol": "XAUUSD", "timeframe": "15M", "wins": 2, "losses": 1, "void": 1, "resolved": 3, "win_rate_pct": 66.67}]


def test_groups_symbol_and_timeframe_separately():
    result = summarize_setup_performance([
        {"symbol": "BTCUSD", "timeframe": "1h", "status": "TP2_HIT"},
        {"symbol": "XAUUSD", "timeframe": "15m", "status": "SL_HIT"},
    ])
    assert [(row["symbol"], row["timeframe"]) for row in result["by_market"]] == [("BTCUSD", "1H"), ("XAUUSD", "15M")]
    assert result["overall"]["win_rate_pct"] == 50.0


def test_no_resolved_records_has_zero_win_rate():
    result = summarize_setup_performance([{"status": "VOID"}, {"status": "DETECTED"}])
    assert result["overall"]["resolved"] == 0
    assert result["overall"]["win_rate_pct"] == 0.0


def test_ignores_non_mapping_and_unrecognized_terminal_statuses():
    result = summarize_setup_performance([None, "TP1_HIT", {"status": "CANCELLED"}, {"status": "SL_HIT"}])
    assert result["overall"]["wins"] == 0
    assert result["overall"]["losses"] == 1


def test_method_discloses_cost_and_outcome_limitations():
    result = summarize_setup_performance([])
    assert "excludes execution costs" in result["method"]
    assert "unresolved" in result["method"]
