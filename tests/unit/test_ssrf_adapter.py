"""Garde anti-SSRF partagé des adapters (adapters/ssrf.py) — DNS hors event loop.

La vérification domaine (`assert_resolved_ip_is_public`) reste sync/pure ; le wrapper
async la déporte dans un thread (`anyio.to_thread`) pour ne pas geler l'event loop
pendant `socket.getaddrinfo`. On vérifie ici que le wrapper propage bien le verdict.
"""

from __future__ import annotations

import socket

import pytest

from itsm_modern_ai.adapters.ssrf import (
    assert_host_resolves_public,
    make_guarded_event_hooks,
    ssrf_request_hook,
)
from itsm_modern_ai.domain.url_safety import UrlSafetyError


def _fake_getaddrinfo(ip: str):
    def fake(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]

    return fake


async def test_private_resolution_blocked_via_thread(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("10.0.0.5"))
    with pytest.raises(UrlSafetyError):
        await assert_host_resolves_public("rebind.example.com")


async def test_public_resolution_passes(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("93.184.216.34"))
    await assert_host_resolves_public("api.example.com")  # ne lève pas


async def test_allow_local_tolerates_private(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("127.0.0.1"))
    await assert_host_resolves_public("localhost", allow_local=True)  # cas Ollama


async def test_request_hook_blocks_internal_host(monkeypatch):
    import httpx

    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("192.168.1.10"))
    hook = ssrf_request_hook(allow_local=False)
    with pytest.raises(UrlSafetyError):
        await hook(httpx.Request("GET", "https://internal.example.com/v1"))


def test_make_guarded_event_hooks_disabled_returns_none():
    assert make_guarded_event_hooks(guard=False) is None


def test_make_guarded_event_hooks_enabled_has_request_hook():
    hooks = make_guarded_event_hooks(guard=True, allow_local=True)
    assert hooks is not None and len(hooks["request"]) == 1
