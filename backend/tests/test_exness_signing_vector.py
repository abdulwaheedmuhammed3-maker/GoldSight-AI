"""Verify Exness request signing against the official synthetic test vector.

The key and API identifier below are public test values from Exness docs.
They must never be used for live authentication.
"""
import app.exness as exness


def test_exness_signing_matches_official_synthetic_vector(monkeypatch):
    monkeypatch.setenv(
        "EXN_PRIVATE_KEY",
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    )
    monkeypatch.setenv("EXN_API_KEY", "exnsk-synthetic-example")
    monkeypatch.setattr(exness.time, "time", lambda: 1773656070.123)

    headers = exness._signed_headers(
        "GET",
        "/v1/trading/access-point?account_id=123456",
        body=b"",
    )

    assert headers["EXN-API-KEY"] == "exnsk-synthetic-example"
    assert headers["EXN-IDEMPOTENCY-KEY"] == ""
    assert headers["EXN-TIMESTAMP"] == "1773656070123"
    assert headers["EXN-SIGN-VERSION"] == "1"
    assert headers["EXN-DATA"] == (
        "eyJhcGlfa2V5IjoiZXhuc2stc3ludGhldGljLWV4YW1wbGUiLCJpZGVtcG90ZW5jeV9rZXkiOiIi"
        "LCJ0aW1lc3RhbXAiOjE3NzM2NTYwNzAxMjMsInNpZ25fdmVyc2lvbiI6MSwibWV0aG9kIjoiR0VU"
        "IiwicGF0aCI6Ii92MS90cmFkaW5nL2FjY2Vzcy1wb2ludD9hY2NvdW50X2lkPTEyMzQ1NiIsImJv"
        "ZHlfaGFzaCI6IjQ3REVRcGo4SEJTYS1fVEltVy01SkNldVFlUmttNU5NcEpXWkczaFN1RlUifQ"
    )
    assert headers["EXN-SIGN"] == (
        "l-H_Acia8YoTjKFMg-3fon3NOEX8TalNVA7c01DQ9dHb7pVBJC4y06qC-DbpETzh1KToiOprqEV6uzN3t69ICQ"
    )
