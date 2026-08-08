"""Healthcheck (FR-27). Reflète l'état GLPI ET LLM ; échec si GLPI injoignable.

Durcissement audit 2026-08 — `/health` était un AMPLIFICATEUR de requêtes sortantes :
un GET anonyme déclenchait 5 requêtes vers le GLPI du client (initSession/killSession ×2
+ getGlpiConfig), et `?probe=true` ajoutait un appel facturé au fournisseur LLM. Ni cache,
ni authentification, ni limite — alors que le compose publie le port sur `0.0.0.0`.
Trois garde-fous :
  1. CACHE TTL sur le résultat complet (pas seulement sur la version GLPI) : le volume
     sortant est borné quel que soit le volume entrant ;
  2. `?probe=true` réservé aux sessions ADMIN : la sonde LLM coûte de l'argent, elle ne
     s'ouvre pas à un anonyme ;
  3. `/health/live` — liveness minimale (process + base, AUCUN appel sortant), destinée aux
     healthchecks d'orchestrateur qui frappent toutes les 10-30 s.
Enfin, un secret illisible (MASTER_KEY incohérente) rend un 503 EXPLICITE et non un 500
opaque : le diagnostic doit désigner la cause, pas une erreur serveur anonyme.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from ...domain.errors import SecretDecryptError
from ..runtime import build_connector, build_llm
from ..security import session_is_authenticated

router = APIRouter(tags=["health"])

# Durée de validité du résultat de `/health`. Assez court pour rester une sonde honnête
# (une panne GLPI est vue en quelques secondes), assez long pour que marteler l'endpoint
# n'amplifie plus rien : au pire 1 aller-retour GLPI toutes les 15 s, quel que soit le
# nombre d'appelants. Constante de module (pas un réglage) : la borner ne doit pas être
# désactivable depuis la config.
HEALTH_CACHE_TTL_SECONDS = 15.0


class GlpiHealth(BaseModel):
    configured: bool
    reachable: bool
    version: str | None = None  # version du serveur GLPI (ex. « 10.0.18 »), si connue


class LlmHealth(BaseModel):
    configured: bool
    reachable: bool | None = None  # None = non sondé (sonde sur ?probe=true)


class Health(BaseModel):
    status: str  # "ok" | "degraded"
    glpi: GlpiHealth
    llm: LlmHealth


class LiveHealth(BaseModel):
    """Liveness : le process répond-il et sa base est-elle ouvrable ? Rien d'autre."""

    status: str  # "ok" | "degraded"
    database: bool


@router.get("/health/live", response_model=LiveHealth)
def health_live(response: Response) -> LiveHealth:
    """Sonde de vivacité SANS aucun appel sortant (process + base uniquement).

    C'est CELLE que doivent viser les healthchecks Docker/Portainer/K8s : `/health`
    interroge le GLPI du client, donc un healthcheck toutes les 10 s y générait un trafic
    permanent vers un tiers — et rendait le conteneur « unhealthy » sur une panne GLPI, qui
    n'est pas une panne du moteur. Ici, seule une base injoignable dégrade l'état.
    """
    from sqlalchemy import text

    from ...persistence import db

    database = True
    try:
        with db.session_scope() as session:
            session.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001 — toute panne de base = liveness dégradée
        database = False
    if not database:
        response.status_code = 503
    return LiveHealth(status="ok" if database else "degraded", database=database)


@router.get("/health", response_model=Health)
async def health(request: Request, response: Response, probe: bool = False) -> Health:
    # (b) La sonde LLM est un appel SORTANT FACTURÉ : réservée aux sessions admin. Un
    # anonyme qui demande ?probe=true est refusé plutôt que servi en mode dégradé, pour que
    # l'exploitant voie tout de suite qu'il lui manque une session (silence = incident muet).
    if probe and not session_is_authenticated(request):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "unauthorized",
                "message": "La sonde LLM (?probe=true) requiert une session administrateur.",
            },
        )

    # (a) Cache TTL sur le résultat COMPLET, séparé par `probe` (les deux variantes n'ont ni
    # le même coût ni le même contenu). Le code de statut est mémorisé avec le corps, sinon
    # une réponse « degraded » servie depuis le cache repartirait en 200.
    cached = _cache_get(request, probe)
    if cached is not None:
        body, status_code = cached
        response.status_code = status_code
        return body

    settings = request.app.state.settings
    secrets = request.app.state.secrets_box

    # (d) Un secret illisible (MASTER_KEY incohérente / volume restauré sans master.key)
    # remontait en 500 opaque, pendant que /api/status restait au vert : diagnostic
    # impossible. On rend un 503 nommé, qui DIT quoi vérifier.
    try:
        connector = build_connector(settings, secrets)
        glpi_configured = connector is not None
        glpi_reachable = await connector.healthcheck() if connector is not None else False

        # Version GLPI (best-effort) — mise en cache par base_url pour éviter un appel
        # `getGlpiConfig` à chaque sonde (/health est appelé fréquemment par l'UI/le proxy).
        glpi_version = None
        if connector is not None and glpi_reachable:
            glpi_version = await _glpi_version(request, connector)

        llm = build_llm(settings, secrets)
    except SecretDecryptError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "secrets_unreadable",
                "message": (
                    "Secrets illisibles : la clé de chiffrement ne correspond pas aux données "
                    "stockées. Vérifiez MASTER_KEY / data/master.key, ou reconfigurez les "
                    "secrets (tokens GLPI, clé LLM)."
                ),
            },
        ) from exc

    llm_configured = llm is not None
    # Sonde LLM uniquement sur demande (évite coût/latence sur le healthcheck du proxy).
    llm_reachable = (await llm.healthcheck()) if (probe and llm is not None) else None

    # GLPI non configuré n'est pas un échec dur en pilote (secrets à pousser via l'UI).
    ok = (not glpi_configured) or glpi_reachable
    if probe and llm_configured and llm_reachable is False:
        ok = False
    status_code = 200 if ok else 503
    if not ok:
        response.status_code = status_code
    body = Health(
        status="ok" if ok else "degraded",
        glpi=GlpiHealth(configured=glpi_configured, reachable=glpi_reachable, version=glpi_version),
        llm=LlmHealth(configured=llm_configured, reachable=llm_reachable),
    )
    _cache_put(request, probe, body, status_code)
    return body


def _cache_get(request: Request, probe: bool) -> tuple[Health, int] | None:
    """Entrée de cache encore valide pour cette variante, sinon None."""
    cache = getattr(request.app.state, "health_cache", None)
    entry = cache.get(probe) if isinstance(cache, dict) else None
    if entry is None:
        return None
    expires_at, body, status_code = entry
    # `time.monotonic` (et non `time()`) : insensible à un recalage d'horloge, qui pourrait
    # sinon figer le cache très longtemps ou l'invalider en boucle.
    if time.monotonic() >= expires_at:
        return None
    return body, status_code


def _cache_put(request: Request, probe: bool, body: Health, status_code: int) -> None:
    cache = getattr(request.app.state, "health_cache", None)
    if not isinstance(cache, dict):
        cache = {}
        request.app.state.health_cache = cache
    cache[probe] = (time.monotonic() + HEALTH_CACHE_TTL_SECONDS, body, status_code)


async def _glpi_version(request: Request, connector) -> str | None:
    """Version GLPI avec cache (base_url → version) sur app.state. Refetch si l'URL change."""
    cache = getattr(request.app.state, "glpi_version_cache", None)
    if cache is not None and cache.get("base_url") == connector.base_url:
        return cache.get("version")
    version = await connector.server_version()
    request.app.state.glpi_version_cache = {"base_url": connector.base_url, "version": version}
    return version
