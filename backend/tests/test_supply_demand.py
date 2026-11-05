import pytest

from app.supply_demand import confirmed_pivots, cluster_zones, detect_supply_demand_zones


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
    bars = _bars([8, 9, 12, 9, 8, 9, 10], [6, 5, 4, 5, 6, 5, 4])
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
