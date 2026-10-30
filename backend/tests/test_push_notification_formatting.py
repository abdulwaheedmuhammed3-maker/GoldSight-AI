from app.push_notifications import _format_notification_price


def test_gold_notification_prices_use_two_decimals():
    assert _format_notification_price("XAUUSD", 3972.256035714286) == "3,972.26"


def test_crypto_notification_prices_use_two_decimals():
    assert _format_notification_price("BTCUSD", 67234.987654) == "67,234.99"


def test_major_fx_notification_prices_use_five_decimals():
    assert _format_notification_price("EURUSD", 1.08456789) == "1.08457"
    assert _format_notification_price("GBPUSD", 1.27123456) == "1.27123"


def test_missing_or_invalid_notification_price_is_safe():
    assert _format_notification_price("XAUUSD", None) == "—"
    assert _format_notification_price("XAUUSD", "not-a-price") == "—"
