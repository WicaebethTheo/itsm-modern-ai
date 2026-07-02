"""Client HTTP de l'API haut-niveau GLPI 11 (« V2 ») — OAuth2 Bearer. **Beta**.

Diffère du client legacy (`apirest.php`) : plus de `Session-Token`, mais un jeton OAuth2
obtenu par grant **password** sur `{…}/api.php/token`, mis en cache et renouvelé à
l'expiration. Anti-SSRF runtime (résolution DNS) repris à l'identique. Traduit les échecs
HTTP/réseau en erreurs typées du domaine.
"""

from __future__ import annotations

import time
from types import TracebackType

import httpx

from .....config.credentials import GlpiV2Credentials
from .....domain.errors import ItsmAuthError, ItsmError, ItsmUnavailableError
from .....domain.url_safety import UrlSafetyError
from ....ssrf import make_guarded_event_hooks

# Marge de renouvellement : on rafraîchit le jeton un peu avant son expiration réelle.
_TOKEN_REFRESH_MARGIN_S = 60


def _ssrf_event_hooks(guard: bool) -> dict[str, list] | None:
    """Event hook httpx anti-SSRF (garde partagé, DNS hors event loop). GLPI n'est jamais local."""
    return make_guarded_event_hooks(guard=guard, allow_local=False)


def token_endpoint(base_url: str) -> str:
    """URL du endpoint OAuth token : `{…}/api.php/token` (global, hors préfixe de version).

    `base_url` pointe sur la racine versionnée (`…/api.php/v2.3`) → on tronque au marqueur
    `/api.php` pour reconstruire l'endpoint token non versionné.
    """
    base = base_url.strip().rstrip("/")
    marker = "/api.php"
    idx = base.find(marker)
    root = base[: idx + len(marker)] if idx != -1 else base
    return f"{root}/token"


class GlpiV2Client:
    def __init__(
        self,
        creds: GlpiV2Credentials,
        *,
        ssrf_guard: bool = False,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not creds.is_configured:
            raise ItsmUnavailableError(
                "GLPI V2 non configuré (base_url + client OAuth + compte technique requis)."
            )
        self._creds = creds
        self._base = creds.base_url.rstrip("/")
        self._token: str | None = None
        self._token_deadline: float = 0.0  # time.monotonic() au-delà duquel on renouvelle
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            verify=creds.verify_tls,
            timeout=creds.timeout_seconds,
            event_hooks=_ssrf_event_hooks(ssrf_guard) or {},
        )

    # ── OAuth2 ──────────────────────────────────────────────────────────────────
    async def _ensure_token(self) -> None:
        if self._token is not None and time.monotonic() < self._token_deadline:
            return
        body = {
            "grant_type": "password",
            "client_id": self._creds.client_id,
            "client_secret": self._creds.client_secret,
            "username": self._creds.username,
            "password": self._creds.password,
            "scope": self._creds.scope or "api user",
        }
        try:
            # OAuth2 (RFC 6749 §4.3.2) : corps en application/x-www-form-urlencoded (`data=`),
            # standard et le plus portable entre instances GLPI (le JSON est toléré mais
            # pas garanti partout).
            resp = await self._client.post(token_endpoint(self._base), data=body)
        except UrlSafetyError as exc:
            raise ItsmUnavailableError(f"Appel GLPI bloqué (anti-SSRF): {exc}") from exc
        except httpx.HTTPError as exc:
            raise ItsmUnavailableError(f"GLPI injoignable (token): {exc}") from exc
        if resp.status_code in (400, 401, 403):
            raise ItsmAuthError(f"OAuth GLPI refusé ({resp.status_code}).")
        if resp.status_code >= 400:
            raise ItsmUnavailableError(f"Endpoint token a échoué ({resp.status_code}).")
        data = resp.json()
        token = data.get("access_token")
        if not token:
            raise ItsmAuthError("OAuth GLPI : pas d'access_token dans la réponse.")
        self._token = str(token)
        try:
            expires_in = int(data.get("expires_in") or 3600)
        except (TypeError, ValueError):
            expires_in = 3600
        self._token_deadline = time.monotonic() + max(30, expires_in - _TOKEN_REFRESH_MARGIN_S)

    def _auth_headers(self) -> dict[str, str]:
        if self._token is None:
            raise ItsmError("Jeton OAuth GLPI non initialisé.")
        return {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}

    # ── requêtes ──────────────────────────────────────────────────────────────
    async def get(self, path: str, params: dict | None = None) -> httpx.Response:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, json: dict | None = None) -> httpx.Response:
        return await self._request("POST", path, json=json)

    async def patch(self, path: str, json: dict | None = None) -> httpx.Response:
        return await self._request("PATCH", path, json=json)

    async def delete(self, path: str, json: dict | None = None) -> httpx.Response:
        return await self._request("DELETE", path, json=json)

    async def _request(self, method: str, path: str, **kw) -> httpx.Response:
        await self._ensure_token()
        url = f"{self._base}/{path.lstrip('/')}"
        try:
            resp = await self._client.request(method, url, headers=self._auth_headers(), **kw)
        except UrlSafetyError as exc:
            raise ItsmUnavailableError(f"Appel GLPI bloqué (anti-SSRF): {exc}") from exc
        except httpx.HTTPError as exc:
            raise ItsmUnavailableError(f"GLPI injoignable: {exc}") from exc
        if resp.status_code == 401:
            # Jeton invalidé côté serveur → on force un renouvellement au prochain appel.
            self._token = None
            raise ItsmAuthError("Jeton OAuth GLPI expiré/invalide (401).")
        if resp.status_code >= 400:
            raise ItsmError(f"GLPI V2 {method} {path} → {resp.status_code}: {resp.text[:200]}")
        return resp

    async def search(
        self,
        resource: str,
        *,
        filter: str | None = None,
        sort: str | None = None,
        start: int = 0,
        limit: int = 100,
    ) -> list[dict]:
        """Une page de résultats (RSQL `filter`, `sort=champ:dir`, pagination `start`/`limit`)."""
        params: dict[str, object] = {"start": start, "limit": limit}
        if filter:
            params["filter"] = filter
        if sort:
            params["sort"] = sort
        data = (await self.get(resource, params=params)).json()
        if isinstance(data, list):
            return data
        return [data] if isinstance(data, dict) else []

    async def search_all(
        self,
        resource: str,
        *,
        filter: str | None = None,
        sort: str | None = None,
        page_size: int = 100,
        hard_cap: int = 1000,
    ) -> list[dict]:
        """Pagine jusqu'à épuisement (ou `hard_cap`) — pour les référentiels volumineux."""
        out: list[dict] = []
        start = 0
        while len(out) < hard_cap:
            page = await self.search(
                resource, filter=filter, sort=sort, start=start, limit=page_size
            )
            out.extend(page)
            if len(page) < page_size:
                break
            start += page_size
        return out[:hard_cap]

    # ── context manager ─────────────────────────────────────────────────────────
    async def __aenter__(self) -> GlpiV2Client:
        await self._ensure_token()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._owns_client:
            await self._client.aclose()
