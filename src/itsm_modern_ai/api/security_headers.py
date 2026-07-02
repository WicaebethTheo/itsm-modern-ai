"""En-têtes de sécurité HTTP posés sur TOUTES les réponses (durcissement audit 2026-06).

Middleware ASGI pur (pas de BaseHTTPMiddleware : pas de re-bufferisation du corps, donc
aucun surcoût sur les streams — /metrics, export CSV, assets). Politique :

- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`
  sur toutes les réponses (inoffensif sur du JSON, indispensable sur le HTML) ;
- CSP sur les réponses **HTML uniquement** (la SPA Vite : assets `self`, appels API
  same-origin, styles inline injectés par les composants → `style-src 'unsafe-inline'`,
  fond SVG encodé en data: → `img-src data:`). Les pages `/docs`/`/redoc` (dev only,
  `EXPOSE_API_DOCS=true`) chargent Swagger/ReDoc depuis un CDN + script inline : elles
  sont EXEMPTÉES de CSP pour ne pas les casser ;
- `Strict-Transport-Security` UNIQUEMENT si `session_https_only=true` (derrière TLS) :
  poser HSTS sur un pilote HTTP rendrait le site inaccessible après passage en HTTPS raté.
"""

from __future__ import annotations

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# CSP de la SPA (vérifiée contre frontend/dist : aucun script inline, styles inline
# possibles via les composants React, fond en data:svg dans le CSS compilé).
SPA_CSP = (
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
    "frame-ancestors 'none'"
)

# 1 an, valeur usuelle recommandée (sans preload : décision du déployeur).
_HSTS_VALUE = "max-age=31536000; includeSubDomains"

# Pages de docs interactives (montées seulement si EXPOSE_API_DOCS=true) : HTML avec
# scripts CDN + inline → la CSP SPA les casserait. Exemption par PRÉFIXE et non par
# égalité stricte : `/docs/oauth2-redirect` (page FastAPI avec script inline) doit être
# couvert aussi. Elles restent couvertes par les autres en-têtes (nosniff, frame, referrer).
_CSP_EXEMPT_PREFIXES = ("/docs", "/redoc")


def _csp_exempt(path: str) -> bool:
    """Vrai si `path` est une page de docs interactives (ou une sous-page, ex. oauth2-redirect)."""
    # `== p` ou `p + "/"` : ne pas exempter par accident un futur `/docsomething`.
    return any(path == p or path.startswith(p + "/") for p in _CSP_EXEMPT_PREFIXES)


class SecurityHeadersMiddleware:
    """Ajoute les en-têtes de sécurité sur chaque réponse HTTP sortante."""

    def __init__(self, app: ASGIApp, *, hsts: bool = False, csp: str = SPA_CSP) -> None:
        self.app = app
        self._hsts = hsts
        self._csp = csp

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":  # lifespan, websocket : rien à faire
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Content-Type-Options"] = "nosniff"
                headers["X-Frame-Options"] = "DENY"
                headers["Referrer-Policy"] = "same-origin"
                if self._hsts:
                    headers["Strict-Transport-Security"] = _HSTS_VALUE
                # CSP réservée au HTML (SPA) : inutile sur le JSON/CSV, et surtout on ne
                # veut pas casser /docs (Swagger CDN) ni /metrics (text/plain).
                content_type = headers.get("content-type", "")
                if content_type.startswith("text/html") and not _csp_exempt(path):
                    headers.setdefault("Content-Security-Policy", self._csp)
            await send(message)

        await self.app(scope, receive, send_with_headers)
