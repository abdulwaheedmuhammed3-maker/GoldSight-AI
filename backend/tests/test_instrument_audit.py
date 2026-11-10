from app import instrument_audit


def test_audit_starts_in_background_and_returns_progress():
    result = instrument_audit.start_or_get_audit()
    assert result["status"] == "running"
    assert result["audit_id"]
    assert result["total_checks"] == len(instrument_audit.SYMBOLS) * 5


def test_unknown_audit_id_returns_none():
    assert instrument_audit.get_audit("not-a-real-audit-id") is None
