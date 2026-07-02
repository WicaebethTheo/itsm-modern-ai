"""Garde anti-SSRF runtime partagé par les adapters HTTP (LLM, GLPI legacy et V2).

Factorise l'event hook httpx « request » qui, juste avant chaque appel sortant, résout
l'hôte et bloque toute IP interne (anti DNS-rebinding, audit 2026-05). La vérification
elle-même (`assert_resolved_ip_is_public`) reste une fonction SYNC du domaine (module
pur) ; ici on la **déporte dans un thread** (`anyio.to_thread`) car `socket.getaddrinfo`
est bloquant : appelé tel quel depuis un hook async, il gelait tout l'event loop pendant
la résolution DNS (audit 2026-06).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import httpx
from anyio import to_thread

from ..domain.url_safety import assert_resolved_ip_is_public


async def assert_host_resolves_public(host: str, *, allow_local: bool = False) -> None:
    """Variante async de `assert_resolved_ip_is_public` : résolution DNS hors event loop.

    Lève `UrlSafetyError` (propagée depuis le thread) si une IP résolue est interne.
    """

    def _check() -> None:
        assert_resolved_ip_is_public(host, allow_local=allow_local)

    await to_thread.run_sync(_check)


def ssrf_request_hook(*, allow_local: bool = False) -> Callable[[httpx.Request], Awaitable[None]]:
    """Event hook httpx « request » : bloque tout appel sortant vers une IP interne.

    À installer sur le client (`event_hooks={"request": [hook]}`) UNIQUEMENT en production
    (cf. `settings.ssrf_guard_enabled`). En test, on ne l'installe pas → respx intercepte.
    """

    async def _hook(request: httpx.Request) -> None:
        await assert_host_resolves_public(request.url.host or "", allow_local=allow_local)

    return _hook


def make_guarded_event_hooks(*, guard: bool, allow_local: bool = False) -> dict[str, list] | None:
    """Mapping `event_hooks` httpx avec le garde anti-SSRF si `guard`, sinon None."""
    if not guard:
        return None
    return {"request": [ssrf_request_hook(allow_local=allow_local)]}
