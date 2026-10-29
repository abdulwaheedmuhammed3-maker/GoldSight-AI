import pytest

from app.exness import TIMEFRAMES, _b64url, _private_key
from app.market import MarketUnavailable


def test_exness_timeframes_match_documented_candle_api():
    assert TIMEFRAMES["5m"] == ("M5", 300)
    assert TIMEFRAMES["15m"] == ("M15", 900)
    assert TIMEFRAMES["30m"] == ("M30", 1800)
    assert TIMEFRAMES["1h"] == ("H1", 3600)
    assert TIMEFRAMES["4h"] == ("H4", 14400)


def test_base64url_is_unpadded():
    assert "=" not in _b64url(b"goldsight")


def test_private_key_missing_fails_closed(monkeypatch):
    monkeypatch.delenv("EXN_PRIVATE_KEY", raising=False)
    with pytest.raises(MarketUnavailable, match="EXN_PRIVATE_KEY"):
        _private_key()


def test_private_key_invalid_fails_closed(monkeypatch):
    monkeypatch.setenv("EXN_PRIVATE_KEY", "not-a-valid-key")
    with pytest.raises(MarketUnavailable, match="Ed25519"):
        _private_key()
