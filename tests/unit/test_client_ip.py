"""Résolution de l'IP client — XFF respecté si proxy fiable, sinon `request.client.host`.

Couvre le contournement du rate-limit derrière un reverse proxy (FR-24 + FR-26) : l'IP
fiable est celle posée par NOTRE proxy (à DROITE de `X-Forwarded-For`), pas la valeur de
gauche qui est fournie par le client (spoofable).
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


def test_one_trusted_proxy_takes_rightmost():
    # Un seul proxy : il AJOUTE à droite l'IP qu'il a vue → c'est elle, l'IP fiable.
    req = _request(headers=[(b"x-forwarded-for", b"203.0.113.5, 10.0.0.1")])
    assert client_ip(req, trusted_proxies=True) == "10.0.0.1"


def test_spoofed_left_entries_are_ignored():
    # Le client injecte de fausses IP à gauche ; seul le dernier saut (notre proxy) compte.
    req = _request(headers=[(b"x-forwarded-for", b"1.1.1.1, 2.2.2.2, 203.0.113.9")])
    assert client_ip(req, trusted_proxies=True, trusted_hops=1) == "203.0.113.9"


def test_two_trusted_proxies_takes_second_from_right():
    # Chaîne de 2 proxys de confiance → l'IP client est la 2e en partant de la droite.
    req = _request(headers=[(b"x-forwarded-for", b"203.0.113.9, 10.0.0.2, 10.0.0.3")])
    assert client_ip(req, trusted_proxies=True, trusted_hops=2) == "10.0.0.2"


def test_hops_longer_than_chain_clamps_to_leftmost():
    # Moins d'entrées que de proxys attendus → on retombe sur la valeur connue la plus à gauche.
    req = _request(headers=[(b"x-forwarded-for", b"203.0.113.9, 10.0.0.2")])
    assert client_ip(req, trusted_proxies=True, trusted_hops=5) == "203.0.113.9"


def test_with_trust_but_no_header_falls_back_to_client_host():
    req = _request(headers=[])
    assert client_ip(req, trusted_proxies=True) == "1.2.3.4"


def test_empty_or_malformed_header_falls_back_without_exception():
    req = _request(headers=[(b"x-forwarded-for", b"")])
    assert client_ip(req, trusted_proxies=True) == "1.2.3.4"
    req2 = _request(headers=[(b"x-forwarded-for", b", , ")])
    assert client_ip(req2, trusted_proxies=True) == "1.2.3.4"


def test_no_client_and_no_header_returns_unknown():
    req = _request(client_host=None, headers=[])
    assert client_ip(req, trusted_proxies=False) == "unknown"
    assert client_ip(req, trusted_proxies=True) == "unknown"
