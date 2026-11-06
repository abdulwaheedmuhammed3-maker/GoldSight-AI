import pytest

from app.supply_demand import confirmed_pivots, cluster_zones, detect_supply_demand_zones, classify_and_invalidate_zones


def _bars(highs, lows=None):
    lows = lows or [h - 2 for h in highs]
    return [
        {"time": i * 900, "open": (h + l) / 2, "high": h, "low": l, "close": (h + l) / 2}
        for i, (h, l) in enumerate(zip(highs, lows))
    ]


def test_pivot_requires_right_side_confirmation_and_strict_extreme():
    bars = _bars([8, 9, 12, 9, 8, 9, 10], [6, 5, 4, 5, 6, 5, 4])
    found = confirmed_pivots(bars, left=2, right=2)
    assert [p["price"] for p in found["highs"]] == [12]
    assert all(p["index"] <= len(bars) - 3 for p in found["highs"])


def test_pivots_do_not_include_unconfirmed_tail():
    bars = _bars([8, 9, 10, 9, 8, 15], [6, 5, 4, 5, 6, 1])
    found = confirmed_pivots(bars, left=2, right=2)
    assert 15 not in [p["price"] for p in found["highs"]]
    assert 1 not in [p["price"] for p in found["lows"]]


def test_explicitly_forming_candle_is_excluded_from_confirmation_window():
    # The final candle is one of the two required right-side confirmation bars.
    bars = _bars([8, 9, 12, 9, 8], [6, 5, 4, 5, 6])
    bars[-1]["closed"] = False
    found = confirmed_pivots(bars, left=2, right=2)
    assert 12 not in [p["price"] for p in found["highs"]]
    assert 4 not in [p["price"] for p in found["lows"]]


def test_cluster_groups_nearby_pivots_and_preserves_zone_bounds():
    pivots = [{"time": 1, "price": 100}, {"time": 2, "price": 100.4}, {"time": 3, "price": 103}]
    zones = cluster_zones(pivots, side="DEMAND", tolerance=0.5)
    assert len(zones) == 2
    assert zones[0]["lower"] == 100
    assert zones[0]["upper"] == pytest.approx(100.4)
    assert zones[0]["pivot_count"] == 2
    assert zones[0]["strength_score"] == 40


def test_cluster_never_merges_a_chain_wider_than_tolerance():
    pivots = [{"time": 1, "price": 100}, {"time": 2, "price": 100.4}, {"time": 3, "price": 100.8}]
    zones = cluster_zones(pivots, side="SUPPLY", tolerance=0.5)
    assert len(zones) == 2
    assert all(zone["upper"] - zone["lower"] <= 0.5 for zone in zones)
    assert zones[0]["pivot_count"] == 2
    assert zones[1]["pivot_count"] == 1


def test_zone_detector_scales_tolerance_from_atr():
    bars = _bars([8, 9, 12, 9, 8, 9, 10], [6, 5, 4, 5, 6, 5, 4])
    result = detect_supply_demand_zones(bars, atr=2, left=2, right=2, tolerance_atr=0.5)
    assert result["tolerance"] == 1
    assert result["supply"][0]["side"] == "SUPPLY"
    assert result["demand"][0]["side"] == "DEMAND"


@pytest.mark.parametrize("atr", [0, -1, float("nan"), float("inf")])
def test_detector_rejects_invalid_atr(atr):
    with pytest.raises(ValueError, match="ATR"):
        detect_supply_demand_zones([], atr=atr)


@pytest.mark.parametrize("side", ["", "BUY", "SELL"])
def test_cluster_rejects_invalid_side(side):
    with pytest.raises(ValueError, match="side"):
        cluster_zones([], side=side, tolerance=1)


def test_zone_classification_labels_strength_and_freshness():
    zones = [
        {"side": "DEMAND", "lower": 90, "upper": 92, "strength_score": 70, "touch_count": 1, "last_seen": 100},
        {"side": "DEMAND", "lower": 80, "upper": 82, "strength_score": 30, "touch_count": 3, "last_seen": 100},
    ]
    result = classify_and_invalidate_zones(zones, [], side="DEMAND")
    assert result[0]["strength_class"] == "STRONG"
    assert result[0]["freshness"] == "FRESH"
    assert result[1]["strength_class"] == "WEAK"
    assert result[1]["freshness"] == "TESTED"
    assert all(zone["zone_status"] == "ACTIVE" for zone in result)


def test_demand_zone_invalidated_only_by_completed_close_below_lower_boundary():
    zone = {"side": "DEMAND", "lower": 90, "upper": 92, "strength_score": 40, "touch_count": 0, "last_seen": 100}
    bars = [
        {"time": 110, "open": 91, "high": 92, "low": 88, "close": 91, "closed": False},
        {"time": 120, "open": 91, "high": 92, "low": 89, "close": 89},
    ]
    result = classify_and_invalidate_zones([zone], bars, side="DEMAND")[0]
    assert result["invalidated"] is True
    assert result["zone_status"] == "INVALIDATED"
    assert result["invalidation_time"] == 120


def test_supply_zone_invalidated_by_completed_close_above_upper_boundary():
    zone = {"side": "SUPPLY", "lower": 100, "upper": 102, "strength_score": 40, "touch_count": 0, "last_seen": 100}
    bars = [{"time": 110, "open": 102, "high": 105, "low": 101, "close": 104}]
    result = classify_and_invalidate_zones([zone], bars, side="SUPPLY")[0]
    assert result["invalidated"] is True
    assert result["invalidation_time"] == 110


def test_zone_invalidation_ignores_candles_before_zone_formation():
    zone = {"side": "DEMAND", "lower": 90, "upper": 92, "strength_score": 40, "touch_count": 0, "last_seen": 100}
    bars = [{"time": 90, "open": 91, "high": 92, "low": 88, "close": 89}]
    result = classify_and_invalidate_zones([zone], bars, side="DEMAND")[0]
    assert result["zone_status"] == "ACTIVE"
