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
    with pytest.raises(MarketUnavailable, match="format rejected"):
        _private_key()


def test_hexadecimal_private_key_seed_is_accepted(monkeypatch):
    # Deterministic test vector; this is not a real credential.
    monkeypatch.setenv("EXN_PRIVATE_KEY", "00" * 32)
    key = _private_key()
    assert key.private_bytes_raw() == bytes(32)


def test_128_hex_seed_public_key_pair_is_accepted(monkeypatch):
    # Deterministic non-secret test vector using a zeroed seed.
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    seed = bytes(32)
    private = Ed25519PrivateKey.from_private_bytes(seed)
    public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    monkeypatch.setenv("EXN_PRIVATE_KEY", (seed + public).hex())
    parsed = _private_key()
    assert parsed.private_bytes_raw() == seed


def test_128_hex_mismatched_public_half_is_rejected(monkeypatch):
    monkeypatch.setenv("EXN_PRIVATE_KEY", "00" * 64)
    with pytest.raises(MarketUnavailable, match="format rejected"):
        _private_key()
