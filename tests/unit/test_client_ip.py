"""Résolution de l'IP client — XFF respecté si proxy fiable, sinon `request.client.host`.

Couvre le contournement du rate-limit derrière un reverse proxy (FR-24 + FR-26).
"""

from __future__ import annotations

from fastapi import Request

from itsm_modern_ai.api.client_ip import client_ip


def _request(*, client_host: str | None = "1.2.3.4", headers: list[tuple[bytes, bytes]] | None = None) -> Request:
    """Construit un `Request` ASGI minimal pour tester le helper hors FastAPI."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": headers or [],
        "client": (client_host, 0) if client_host else None,
    }
    return Request(scope)


def test_without_trust_returns_client_host():
    req = _request(headers=[(b"x-forwarded-for", b"203.0.113.5, 10.0.0.1")])
    # XFF présent mais ignoré : on doit garder l'IP TCP.
    assert client_ip(req, trusted_proxies=False) == "1.2.3.4"


def test_with_trust_returns_first_xff_value():
    req = _request(headers=[(b"x-forwarded-for", b"203.0.113.5, 10.0.0.1")])
    assert client_ip(req, trusted_proxies=True) == "203.0.113.5"


def test_with_trust_but_no_header_falls_back_to_client_host():
    req = _request(headers=[])
    assert client_ip(req, trusted_proxies=True) == "1.2.3.4"


def test_empty_or_malformed_header_falls_back_without_exception():
    # XFF vide → fallback sur client.host.
    req = _request(headers=[(b"x-forwarded-for", b"")])
    assert client_ip(req, trusted_proxies=True) == "1.2.3.4"
    # XFF = ", " (que des virgules) → première valeur vide → fallback.
    req2 = _request(headers=[(b"x-forwarded-for", b", , ")])
    assert client_ip(req2, trusted_proxies=True) == "1.2.3.4"


def test_no_client_and_no_header_returns_unknown():
    # Aucune source d'IP exploitable : jamais d'exception, valeur sentinelle.
    req = _request(client_host=None, headers=[])
    assert client_ip(req, trusted_proxies=False) == "unknown"
    assert client_ip(req, trusted_proxies=True) == "unknown"
