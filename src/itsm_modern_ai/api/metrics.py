"""Métriques Prometheus d'infrastructure (durcissement audit 2026-05).

Endpoint NON authentifié `GET /metrics` (scrape classique côté réseau interne,
distinct de `/api/metrics` qui porte les KPI métier sous auth). Désactivable via
`settings.metrics_enabled`.

⚠️ Pas de PII : le label `path` est la ROUTE templatée (ex. `/api/decisions/{id}`),
jamais l'URL concrète, ce qui évite d'émettre des identifiants/valeurs dans les
labels (et borne la cardinalité). Les chemins inconnus sont agrégés en `<other>`.

Exposition contrôlable (durcissement audit 2026-05) : si `settings.metrics_token` est
défini, `/metrics` exige `Authorization: Bearer <token>` (ou en-tête `X-Metrics-Token`),
sinon 401. Vide (défaut) → non authentifié (scrape Prometheus classique, rétrocompatible).
"""

from __future__ import annotations

import secrets as _secrets
import time

from fastapi import FastAPI
from fastapi.routing import iter_route_contexts
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Match

_REQUESTS = Counter(
    "itsm_http_requests_total",
    "Nombre total de requêtes HTTP traitées.",
    ["method", "path", "status"],
)
_LATENCY = Histogram(
    "itsm_http_request_duration_seconds",
    "Latence des requêtes HTTP (secondes).",
    ["method", "path"],
)


def _route_contexts(app) -> list:
    """Vue à plat des routes, calculée UNE fois et mémoïsée sur `app.state`.

    ⚠️ Depuis FastAPI 0.138, `include_router()` n'aplatit plus les routes dans
    `app.routes` : on y trouve des nœuds de routeur paresseux, qui n'ont pas d'attribut
    `path` et dont le `matches()` ne rend pas le chemin templaté de la route finale.
    `iter_route_contexts()` (API publique FastAPI) redonne la vue à plat, chaque contexte
    portant le chemin EFFECTIF (préfixe du routeur appliqué) et le `matches()` de la
    route réelle.

    Pourquoi mémoïser : `_route_template` est appelé par le middleware à CHAQUE requête.
    Reconstruire la vue à plat à chaque fois alloue un `RouteContext` par route et coûte
    ~2,5× le simple parcours de liste d'avant (mesuré 43 µs contre 17 µs sur cette app).
    Le cache est invalidé si `app.routes` change de taille : `install_metrics()` est
    appelé AVANT `mount_spa()` (cf. `api/app.py`), donc la route catch-all de la SPA
    arrive après — un cache figé au démarrage la manquerait et étiquetterait toute l'UI
    en `<other>`.
    """
    cache = getattr(app.state, "route_contexts_cache", None)
    if cache is None or cache[0] != len(app.routes):
        cache = (len(app.routes), list(iter_route_contexts(app.routes)))
        app.state.route_contexts_cache = cache
    return cache[1]


def _route_template(request: Request) -> str:
    """Chemin templaté de la route (borne la cardinalité, évite la PII dans les labels).

    L'ordre d'itération reste l'ordre de déclaration, donc la première correspondance
    FULL est bien celle que le routeur aurait choisie.
    """
    for ctx in _route_contexts(request.app):
        match, _ = ctx.matches(request.scope)
        if match == Match.FULL:
            return ctx.path or "<other>"
    return "<other>"


async def metrics_middleware(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    # On n'instrumente pas l'endpoint /metrics lui-même (bruit de scrape).
    if request.url.path != "/metrics":
        path = _route_template(request)
        elapsed = time.perf_counter() - start
        _REQUESTS.labels(request.method, path, str(response.status_code)).inc()
        _LATENCY.labels(request.method, path).observe(elapsed)
    return response


def _scrape_token_ok(request: Request, expected: str) -> bool:
    """Vrai si la requête porte le bon jeton de scrape (Bearer ou X-Metrics-Token).

    Comparaison à temps constant (`secrets.compare_digest`) pour ne pas fuiter le jeton
    via une attaque temporelle.
    """
    presented = ""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        presented = auth[7:].strip()
    if not presented:
        presented = request.headers.get("x-metrics-token", "").strip()
    # Comparaison en BYTES : `compare_digest(str, str)` lève TypeError sur un caractère
    # non-ASCII (jeton présenté exotique) → 500 au lieu d'un 401 propre. L'encodage UTF-8
    # préserve la comparaison à temps constant tout en acceptant n'importe quel octet.
    return bool(presented) and _secrets.compare_digest(
        presented.encode("utf-8"), expected.encode("utf-8")
    )


async def metrics_endpoint(request: Request) -> Response:
    expected = getattr(request.app.state.settings, "metrics_token", "") or ""
    if expected and not _scrape_token_ok(request, expected):
        return Response(
            '{"code":"unauthorized","message":"Jeton de scrape /metrics requis."}',
            status_code=401,
            media_type="application/json",
        )
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


def install_metrics(app: FastAPI) -> None:
    """Branche le middleware d'instrumentation + la route /metrics.

    Authentification optionnelle : si `settings.metrics_token` est défini, l'endpoint exige
    le jeton de scrape ; sinon il reste non authentifié (rétrocompatible, scrape interne).
    """
    app.middleware("http")(metrics_middleware)
    app.add_route("/metrics", metrics_endpoint, methods=["GET"])
