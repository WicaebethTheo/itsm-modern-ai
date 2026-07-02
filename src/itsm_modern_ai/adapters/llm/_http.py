"""Helpers HTTP partagés entre adapters LLM (OpenAI-compat, Anthropic).

Évite la duplication du pattern « client injecté vs `async with httpx.AsyncClient(...)` »
et centralise la **capture du body 4xx** : sans elle, `LlmTransportError(str(exc))` ne
porte que le code+URL, alors que le body explique souvent la cause (modèle inconnu,
pré-fill refusé, etc.). Cf. audit cybersécu MR !17.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from ...domain.errors import LlmTransportError
from ...domain.url_safety import UrlSafetyError

# Garde anti-SSRF factorisé dans adapters/ssrf.py (partagé avec les clients GLPI) —
# ré-exporté ici pour ne pas casser les imports existants (routes/version.py, adapters LLM).
from ..ssrf import make_guarded_event_hooks, ssrf_request_hook

__all__ = [
    "arequest",
    "healthcheck_get",
    "ssrf_request_hook",
    "make_guarded_event_hooks",
    "UrlSafetyError",
]


async def _with_client(
    injected: httpx.AsyncClient | None,
    timeout: float,
    op: Callable[[httpx.AsyncClient], Awaitable[httpx.Response]],
    event_hooks: dict[str, list] | None = None,
) -> httpx.Response:
    """Exécute `op(client)` en réutilisant le client injecté, sinon en en créant un.

    `event_hooks` (anti-SSRF) ne s'applique qu'au client éphémère créé ici : un client
    injecté (tests) conserve sa propre configuration.
    """
    if injected is not None:
        return await op(injected)
    async with httpx.AsyncClient(timeout=timeout, event_hooks=event_hooks or {}) as client:
        return await op(client)


async def arequest(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    json: dict[str, Any] | None = None,
    client: httpx.AsyncClient | None = None,
    timeout: float = 60.0,
    raise_status: bool = True,
    event_hooks: dict[str, list] | None = None,
) -> httpx.Response:
    """Effectue une requête HTTP en mutualisant le cycle de vie client + erreurs.

    `raise_status=True` (défaut) : lève `LlmTransportError` enrichi du body 4xx/5xx pour
    diagnostic admin. `False` : retourne la `Response` brute (utile pour `healthcheck`
    qui ne veut qu'un booléen statut < 400).
    """

    async def do(c: httpx.AsyncClient) -> httpx.Response:
        return await c.request(method, url, headers=headers, json=json)

    try:
        resp = await _with_client(client, timeout, do, event_hooks=event_hooks)
        if raise_status:
            resp.raise_for_status()
    except UrlSafetyError as exc:
        # Anti-SSRF : l'hôte résout vers une IP interne → on bloque AVANT toute fuite.
        raise LlmTransportError(f"Appel sortant bloqué (anti-SSRF): {exc}") from exc
    except httpx.HTTPStatusError as exc:
        # Body JSON typique : {"error": {"message": "..."}} — essentiel pour qualifier.
        body_excerpt = (exc.response.text or "")[:500].replace("\n", " ")
        raise LlmTransportError(f"{exc} :: body={body_excerpt}") from exc
    except httpx.HTTPError as exc:
        raise LlmTransportError(str(exc)) from exc
    return resp


async def healthcheck_get(
    url: str,
    headers: dict[str, str],
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = 60.0,
    event_hooks: dict[str, list] | None = None,
) -> bool:
    """Sonde légère partagée : True si status < 400, False sur toute erreur réseau."""
    try:
        resp = await arequest(
            "GET", url, headers=headers, client=client, timeout=timeout,
            raise_status=False, event_hooks=event_hooks,
        )
    except LlmTransportError:
        return False
    return resp.status_code < 400
