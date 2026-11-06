import pytest

from app.mtf_confluence import score_mtf_confluence


def test_all_timeframes_aligned_bullish_produces_full_confluence():
    result = score_mtf_confluence({"4H": "bullish", "1H": "bullish", "15M": "bullish", "5M": "bullish"})
    assert result["bias"] == "bullish"
    assert result["confluence_score"] == 100
    assert result["coverage"] == ["4H", "1H", "15M", "5M"]


def test_higher_timeframe_alignment_outweighs_lower_timeframe_opposition():
    result = score_mtf_confluence({"4H": "buy", "1H": "buy", "15M": "sell", "5M": "sell"})
    assert result["bias"] == "bullish"
    assert result["confluence_score"] == 33.33


def test_equal_directional_weight_is_neutral():
    result = score_mtf_confluence({"4H": "bearish", "1H": "bullish"})
    assert result["bias"] == "neutral"
    assert result["confluence_score"] == 0


def test_missing_and_unknown_readings_are_excluded_from_coverage():
    result = score_mtf_confluence({"4H": "bullish", "1H": None, "15M": "unavailable", "5M": "neutral"})
    assert result["coverage"] == ["4H", "5M"]
    assert result["bullish_weight"] == 4
    assert result["neutral_weight"] == 1


@pytest.mark.parametrize("value", [None, [], "not-a-map", 42])
def test_non_mapping_input_is_safe(value):
    result = score_mtf_confluence(value)
    assert result["bias"] == "neutral"
    assert result["confluence_score"] == 0
    assert result["coverage"] == []


def test_bearish_direction_aliases_are_normalized():
    result = score_mtf_confluence({"4H": "short", "1H": "down"})
    assert result["bias"] == "bearish"
    assert result["normalized_directions"] == {"4H": "bearish", "1H": "bearish"}


def test_score_is_labeled_as_alignment_not_probability():
    result = score_mtf_confluence({"4H": "bullish"})
    assert "not win probability" in result["evidence_label"]
