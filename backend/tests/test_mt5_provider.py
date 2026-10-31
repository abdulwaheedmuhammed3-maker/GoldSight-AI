from types import SimpleNamespace

from app import market


class FakeMT5:
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_H1 = 60
    TIMEFRAME_H4 = 240

    def __init__(self, connected=True):
        self.connected = connected
        self.initialize_calls = []
        self.shutdown_calls = 0
        self.selected = []

    def initialize(self, *args):
        self.initialize_calls.append(args)
        return True

    def last_error(self):
        return (0, "ok")

    def terminal_info(self):
        return SimpleNamespace(connected=self.connected)

    def version(self):
        return (5, 0, 45)

    def shutdown(self):
        self.shutdown_calls += 1

    def symbol_info(self, name):
        if name == "XAUUSDm":
            return SimpleNamespace(visible=False)
        return None

    def symbol_select(self, name, visible):
        self.selected.append((name, visible))
        return True


def test_mt5_uses_explicit_terminal_path(monkeypatch):
    import sys

    fake = FakeMT5()
    monkeypatch.setitem(sys.modules, "MetaTrader5", fake)
    monkeypatch.setenv("MT5_TERMINAL_PATH", r"C:\\Program Files\\MetaTrader 5 EXNESS\\terminal64.exe")

    assert market._mt5() is fake
    assert fake.initialize_calls == [(r"C:\\Program Files\\MetaTrader 5 EXNESS\\terminal64.exe",)]


def test_mt5_connection_status_is_read_only_and_shuts_down(monkeypatch):
    import sys

    fake = FakeMT5(connected=True)
    monkeypatch.setitem(sys.modules, "MetaTrader5", fake)
    monkeypatch.delenv("MT5_TERMINAL_PATH", raising=False)

    result = market.mt5_connection_status()

    assert result["status"] == "CONNECTED"
    assert result["terminal_connected"] is True
    assert result["read_only"] is True
    assert result["order_execution_enabled"] is False
    assert "account" not in result
    assert fake.shutdown_calls == 1


def test_mt5_symbol_suffix_can_be_configured(monkeypatch):
    fake = FakeMT5()
    monkeypatch.setenv("MT5_SYMBOL_XAUUSD", "XAUUSDm")

    actual = market._mt5_symbol(fake, "XAUUSD")

    assert actual == "XAUUSDm"
    assert fake.selected == [("XAUUSDm", True)]
