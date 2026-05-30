"""Validation anti-SSRF des URLs de base (module pur domain/url_safety.py)."""

from __future__ import annotations

import pytest

from itsm_modern_ai.domain.url_safety import (
    UrlSafetyError,
    assert_resolved_ip_is_public,
    validate_base_url,
)


@pytest.mark.parametrize(
    "url",
    [
        "https://api.mistral.ai/v1",
        "https://glpi.exemple.local/apirest.php",
        "https://api.openai.com/v1",
    ],
)
def test_public_https_accepted(url):
    assert validate_base_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/v1",
        "https://localhost/v1",
        "https://10.0.0.5/v1",
        "https://192.168.1.10/v1",
        "https://169.254.169.254",  # metadata cloud
        "http://api.mistral.ai/v1",  # http public refusé
        "ftp://example.com",  # schéma non http
    ],
)
def test_dangerous_urls_rejected(url):
    with pytest.raises(UrlSafetyError):
        validate_base_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:11434/v1",
        "http://127.0.0.1:11434/v1",
        "https://192.168.1.50:11434/v1",
    ],
)
def test_ollama_local_allowed_when_allow_local(url):
    assert validate_base_url(url, allow_local=True) == url


def test_empty_url_passes_through():
    assert validate_base_url("") == ""


# ── Anti-SSRF au runtime (résolution DNS — anti DNS rebinding, audit 2026-05) ────
@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "10.0.0.5", "192.168.1.10", "169.254.169.254", "localhost", "::1"],
)
def test_runtime_guard_blocks_internal_literals_and_localhost(host):
    with pytest.raises(UrlSafetyError):
        assert_resolved_ip_is_public(host)


def test_runtime_guard_allows_internal_when_allow_local():
    # Cas Ollama local : explicitement toléré (ne lève pas).
    assert_resolved_ip_is_public("127.0.0.1", allow_local=True)
    assert_resolved_ip_is_public("localhost", allow_local=True)


def test_runtime_guard_blocks_hostname_resolving_to_loopback(monkeypatch):
    """DNS rebinding : un hostname public qui résout vers 127.0.0.1 est bloqué à l'appel."""
    import itsm_modern_ai.domain.url_safety as us

    def _fake_getaddrinfo(host, *a, **kw):
        return [(2, 1, 6, "", ("127.0.0.1", 0))]

    monkeypatch.setattr(us.socket, "getaddrinfo", _fake_getaddrinfo)
    with pytest.raises(UrlSafetyError):
        assert_resolved_ip_is_public("evil.example.com")


def test_runtime_guard_allows_hostname_resolving_to_public(monkeypatch):
    import itsm_modern_ai.domain.url_safety as us

    def _fake_getaddrinfo(host, *a, **kw):
        return [(2, 1, 6, "", ("93.184.216.34", 0))]  # IP publique

    monkeypatch.setattr(us.socket, "getaddrinfo", _fake_getaddrinfo)
    assert assert_resolved_ip_is_public("example.com") is None


def test_runtime_guard_fail_closed_on_dns_failure(monkeypatch):
    import socket as _socket

    import itsm_modern_ai.domain.url_safety as us

    def _boom(host, *a, **kw):
        raise _socket.gaierror("nope")

    monkeypatch.setattr(us.socket, "getaddrinfo", _boom)
    with pytest.raises(UrlSafetyError):
        assert_resolved_ip_is_public("does-not-resolve.invalid")
