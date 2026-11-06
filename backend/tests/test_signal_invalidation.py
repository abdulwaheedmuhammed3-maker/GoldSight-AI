import pytest

from app.signal_invalidation import evaluate_signal_invalidation


@pytest.mark.parametrize("direction", ["buy", "long"])
@pytest.mark.parametrize("current,level,expected", [(99, 100, True), (100, 100, True), (101, 100, False)])
def test_long_signal_invalidation(direction, current, level, expected):
    result = evaluate_signal_invalidation(direction, current, level)
    assert result["invalidated"] is expected
    assert result["status"] == ("invalidated" if expected else "valid")


@pytest.mark.parametrize("direction", ["sell", "short"])
@pytest.mark.parametrize("current,level,expected", [(101, 100, True), (100, 100, True), (99, 100, False)])
def test_short_signal_invalidation(direction, current, level, expected):
    result = evaluate_signal_invalidation(direction, current, level)
    assert result["invalidated"] is expected


@pytest.mark.parametrize(
    "direction,current,level,reason",
    [
        ("hold", 100, 99, "unsupported_direction"),
        ("buy", None, 99, "missing_price"),
        ("sell", 100, None, "missing_price"),
        ("buy", "bad", 99, "invalid_price"),
        ("buy", float("inf"), 99, "non_finite_price"),
    ],
)
def test_unavailable_inputs(direction, current, level, reason):
    result = evaluate_signal_invalidation(direction, current, level)
    assert result["status"] == "unavailable"
    assert result["invalidated"] is None
    assert result["reason"] == reason
