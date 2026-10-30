from app.push_notifications import _format_notification_price


def test_all_instruments_use_two_decimal_places():
    assert _format_notification_price("XAUUSD", 3972.256035714286) == "3,972.26"
    assert _format_notification_price("BTCUSD", 67234.987654) == "67,234.99"
    assert _format_notification_price("EURUSD", 1.08456789) == "1.08"
    assert _format_notification_price("GBPUSD", 1.27123456) == "1.27"


def test_missing_or_invalid_notification_price_is_safe():
    assert _format_notification_price("XAUUSD", None) == "—"
    assert _format_notification_price("XAUUSD", "not-a-price") == "—"
