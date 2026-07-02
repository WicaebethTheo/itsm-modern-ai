"""Client HTTP bas niveau pour l'API GLPI legacy `apirest.php` (addendum §A).

Gère le cycle de session : `initSession` → header `Session-Token` (+ `App-Token`
optionnel). Traduit les échecs HTTP/réseau en erreurs typées du domaine.
"""

from __future__ import annotations

from types import TracebackType

import httpx

from ....domain.errors import ItsmAuthError, ItsmError, ItsmUnavailableError
from ....domain.url_safety import UrlSafetyError
from ...ssrf import make_guarded_event_hooks


def _ssrf_event_hooks(guard: bool) -> dict[str, list] | None:
    """Event hook httpx anti-SSRF (garde partagé, DNS hors event loop). GLPI n'est jamais local."""
    return make_guarded_event_hooks(guard=guard, allow_local=False)


class GlpiClient:
    def __init__(
        self,
        base_url: str,
        user_token: str,
        app_token: str = "",
        *,
        verify_tls: bool = True,
        timeout: float = 30.0,
        ssrf_guard: bool = False,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not base_url or not user_token:
            raise ItsmUnavailableError("GLPI non configuré (base_url et user_token requis).")
        self._base_url = base_url.rstrip("/")
        self._user_token = user_token
        self._app_token = app_token
        self._session_token: str | None = None
        self._owns_client = client is None
        # Garde anti-SSRF (résolution DNS au runtime) sur le client que CE client possède.
        self._client = client or httpx.AsyncClient(
            verify=verify_tls, timeout=timeout, event_hooks=_ssrf_event_hooks(ssrf_guard) or {}
        )

    # ── session ───────────────────────────────────────────────────────────────
    def _base_headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._app_token:
            h["App-Token"] = self._app_token
        return h

    async def init_session(self) -> None:
        headers = self._base_headers() | {"Authorization": f"user_token {self._user_token}"}
        try:
            resp = await self._client.get(f"{self._base_url}/initSession", headers=headers)
        except UrlSafetyError as exc:
            raise ItsmUnavailableError(f"Appel GLPI bloqué (anti-SSRF): {exc}") from exc
        except httpx.HTTPError as exc:
            raise ItsmUnavailableError(f"GLPI injoignable: {exc}") from exc
        if resp.status_code in (400, 401):
            raise ItsmAuthError(f"Authentification GLPI refusée ({resp.status_code}).")
        if resp.status_code >= 400:
            raise ItsmUnavailableError(f"initSession a échoué ({resp.status_code}).")
        token = resp.json().get("session_token")
        if not token:
            raise ItsmAuthError("initSession n'a pas renvoyé de session_token.")
        self._session_token = token

    async def kill_session(self) -> None:
        if self._session_token is None:
            return
        try:
            await self._client.get(f"{self._base_url}/killSession", headers=self._auth_headers())
        except httpx.HTTPError:
            pass  # best-effort
        finally:
            self._session_token = None

    def _auth_headers(self) -> dict[str, str]:
        if self._session_token is None:
            raise ItsmError("Session GLPI non initialisée (appeler init_session).")
        return self._base_headers() | {"Session-Token": self._session_token}

    # ── requêtes ──────────────────────────────────────────────────────────────
    async def get(self, path: str, params: dict | None = None) -> httpx.Response:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, json: dict | None = None) -> httpx.Response:
        return await self._request("POST", path, json=json)

    async def put(self, path: str, json: dict | None = None) -> httpx.Response:
        return await self._request("PUT", path, json=json)

    async def delete(self, path: str, json: dict | None = None) -> httpx.Response:
        return await self._request("DELETE", path, json=json)

    async def _request(self, method: str, path: str, **kw) -> httpx.Response:
        url = f"{self._base_url}/{path.lstrip('/')}"
        try:
            resp = await self._client.request(method, url, headers=self._auth_headers(), **kw)
        except UrlSafetyError as exc:
            raise ItsmUnavailableError(f"Appel GLPI bloqué (anti-SSRF): {exc}") from exc
        except httpx.HTTPError as exc:
            raise ItsmUnavailableError(f"GLPI injoignable: {exc}") from exc
        if resp.status_code == 401:
            raise ItsmAuthError("Session GLPI expirée/invalide (401).")
        if resp.status_code >= 400:
            raise ItsmError(f"GLPI {method} {path} → {resp.status_code}: {resp.text[:200]}")
        return resp

    # ── context manager ─────────────────────────────────────────────────────────
    async def __aenter__(self) -> GlpiClient:
        await self.init_session()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.kill_session()
        if self._owns_client:
            await self._client.aclose()
