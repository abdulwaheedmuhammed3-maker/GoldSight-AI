from app.push_notifications import _format_notification_price, classify_order_type


def test_all_instruments_use_two_decimal_places():
    assert _format_notification_price("XAUUSD", 3972.256035714286) == "3,972.26"
    assert _format_notification_price("BTCUSD", 67234.987654) == "67,234.99"
    assert _format_notification_price("EURUSD", 1.08456789) == "1.08"
    assert _format_notification_price("GBPUSD", 1.27123456) == "1.27"


def test_missing_or_invalid_notification_price_is_safe():
    assert _format_notification_price("XAUUSD", None) == "—"
    assert _format_notification_price("XAUUSD", "not-a-price") == "—"


def test_order_type_classifies_limit_and_stop_from_quote():
    assert classify_order_type("BUY", 100.0, 101.0) == "BUY LIMIT"
    assert classify_order_type("BUY", 102.0, 101.0) == "BUY STOP"
    assert classify_order_type("SELL", 102.0, 101.0) == "SELL LIMIT"
    assert classify_order_type("SELL", 100.0, 101.0) == "SELL STOP"
    assert classify_order_type("BUY", 101.0, 101.0) == "BUY MARKET"


def test_order_type_handles_missing_or_nonfinite_quote_safely():
    assert classify_order_type("SELL", 100.0, None) == "SELL MARKET"
    assert classify_order_type("BUY", 100.0, float("nan")) == "BUY MARKET"
