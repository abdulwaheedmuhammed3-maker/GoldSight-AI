import pytest

from app.zone_quality import rank_zone_quality


def test_fresh_strong_zone_with_impulsive_departure_ranks_high():
    result = rank_zone_quality(
        {"strength_score": 100, "touch_count": 0},
        age_bars=8,
        displacement_atr=2.5,
    )
    assert result["quality_score"] == 90
    assert result["quality_tier"] == "A"
    assert result["components"]["departure_displacement"] == 25


def test_retests_and_age_reduce_zone_rank():
    fresh = rank_zone_quality({"strength_score": 80, "touch_count": 0}, age_bars=10)
    aged = rank_zone_quality({"strength_score": 80, "touch_count": 3}, age_bars=120)
    assert aged["quality_score"] < fresh["quality_score"]


def test_invalidated_zone_receives_penalty():
    active = rank_zone_quality({"strength_score": 60, "touch_count": 1}, age_bars=10)
    broken = rank_zone_quality({"strength_score": 60, "touch_count": 1}, age_bars=10, invalidated=True)
    assert broken["quality_score"] == max(0, active["quality_score"] - 40)
    assert broken["components"]["invalidation_penalty"] == 40


@pytest.mark.parametrize("strength", [float("nan"), float("inf"), "bad", None])
def test_invalid_strength_is_safely_neutralized(strength):
    result = rank_zone_quality({"strength_score": strength, "touch_count": 0})
    assert 0 <= result["quality_score"] <= 100


def test_unknown_optional_metrics_are_neutral_and_explained():
    result = rank_zone_quality({"strength_score": 50, "touch_count": 1})
    assert result["components"]["age"] == 15
    assert result["components"]["departure_displacement"] == 0
    assert "not win probability" in result["evidence_label"]
