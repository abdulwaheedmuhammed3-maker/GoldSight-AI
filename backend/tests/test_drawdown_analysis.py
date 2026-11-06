import pytest
from app.drawdown_analysis import analyze_drawdowns


def test_drawdown_duration_tracks_peak_to_recovery_and_trough():
    # Equity recovers to 105 at index 5, then makes a new peak at index 7.
    # The dip below 105 between those points is a distinct drawdown episode.
    result = analyze_drawdowns([100, 102, 105, 101, 98, 105, 103, 106])
    assert result["episodes"] == [
        {"peak_index": 2, "trough_index": 4, "recovery_index": 5, "duration_trades": 3},
        {"peak_index": 5, "trough_index": 6, "recovery_index": 7, "duration_trades": 2},
    ]
    assert result["max_duration_trades"] == 3
    assert result["longest_recovery"] == {
        "peak_index": 2, "recovery_index": 5, "duration_trades": 3
    }


def test_unrecovered_drawdown_reports_observed_duration():
    result = analyze_drawdowns([100, 104, 102, 99, 97])
    assert result["episodes"] == [
        {"peak_index": 1, "trough_index": 4, "recovery_index": None, "duration_trades": 3}
    ]
    assert result["max_duration_trades"] == 3
    assert result["longest_recovery"]["recovery_index"] is None


def test_drawdown_analysis_handles_flat_and_empty_equity_paths():
    assert analyze_drawdowns([100, 100, 100]) == {
        "episodes": [], "max_duration_trades": 0, "longest_recovery": None
    }
    assert analyze_drawdowns([]) == {
        "episodes": [], "max_duration_trades": 0, "longest_recovery": None
    }


def test_drawdown_analysis_rejects_nonnumeric_values():
    with pytest.raises(ValueError, match="numeric"):
        analyze_drawdowns([100, "bad", 98])
