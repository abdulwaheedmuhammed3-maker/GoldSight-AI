import pytest
from app.stock_portfolio import _owner_hash, record_transaction


def test_portfolio_key_is_stored_as_one_way_hash():
    key = "a" * 48
    assert _owner_hash(key) != key
    assert _owner_hash(key) == _owner_hash(key)


def test_short_portfolio_key_is_rejected():
    with pytest.raises(ValueError, match="private portfolio key"):
        _owner_hash("too-short")


def test_invalid_transaction_is_rejected_before_database_access():
    with pytest.raises(ValueError, match="Quantity and price"):
        record_transaction("a" * 48, country="NG", ticker="GTCO.NG",
                           company="GTCO", side="BUY", quantity=0, price=100)


def test_unsupported_market_is_rejected_before_database_access():
    with pytest.raises(ValueError, match="Unsupported country"):
        record_transaction("a" * 48, country="XX", ticker="ABC",
                           company="Example", side="BUY", quantity=1, price=1)
