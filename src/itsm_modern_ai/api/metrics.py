"""Métriques Prometheus d'infrastructure (durcissement audit 2026-05).

Endpoint NON authentifié `GET /metrics` (scrape classique côté réseau interne,
distinct de `/api/metrics` qui porte les KPI métier sous auth). Désactivable via
`settings.metrics_enabled`.

⚠️ Pas de PII : le label `path` est la ROUTE templatée (ex. `/api/decisions/{id}`),
jamais l'URL concrète, ce qui évite d'émettre des identifiants/valeurs dans les
labels (et borne la cardinalité). Les chemins inconnus sont agrégés en `<other>`.
"""

from __future__ import annotations

import time

from fastapi import FastAPI
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


def _route_template(request: Request) -> str:
    """Chemin templaté de la route (borne la cardinalité, évite la PII dans les labels)."""
    for route in request.app.routes:
        match, _ = route.matches(request.scope)
        if match == Match.FULL:
            return getattr(route, "path", "<other>")
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


async def metrics_endpoint(_request: Request) -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


def install_metrics(app: FastAPI) -> None:
    """Branche le middleware d'instrumentation + la route /metrics (non authentifiée)."""
    app.middleware("http")(metrics_middleware)
    app.add_route("/metrics", metrics_endpoint, methods=["GET"])
