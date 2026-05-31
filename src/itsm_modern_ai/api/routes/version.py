"""Version courante du moteur + vérification de mise à jour — OPT-IN, souverain.

Par défaut, `update_check_url` est vide → AUCUN appel sortant (air-gap / souveraineté
respectés) : l'endpoint ne renvoie que la version courante. Si une URL est configurée,
le moteur l'interroge (best-effort, mis en cache) pour savoir si une version plus récente
existe. Le flux doit renvoyer du JSON {"version": "x.y.z"} (ou {"tag_name": ...}) ou la
version en texte brut.
"""

from __future__ import annotations

import logging
import time

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ... import __version__
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service
from ..security import require_auth

logger = logging.getLogger("itsm.version")
router = APIRouter(prefix="/api", tags=["version"], dependencies=[Depends(require_auth)])

_CACHE_TTL_SECONDS = 6 * 3600  # le flux de versions change rarement


class VersionView(BaseModel):
    current: str
    latest: str | None = None
    update_available: bool = False
    check_enabled: bool = False  # une URL de vérification est-elle configurée ?


def _parse(v: str) -> tuple[int, ...]:
    """Tuple d'entiers depuis 'x.y.z' (tolère préfixe v et suffixes non numériques)."""
    out: list[int] = []
    for part in str(v).strip().lstrip("vV").split("."):
        num = ""
        for ch in part:
            if ch.isdigit():
                num += ch
            else:
                break
        out.append(int(num) if num else 0)
    return tuple(out)


def is_newer(latest: str | None, current: str) -> bool:
    if not latest:
        return False
    try:
        return _parse(latest) > _parse(current)
    except Exception:  # pragma: no cover - défensif
        return False


async def _fetch_latest(url: str, timeout: float) -> str | None:
    """Récupère la dernière version publiée (best-effort). None si indisponible."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype:
                data = resp.json()
                raw = data.get("version") or data.get("tag_name") or ""
                return str(raw).strip().lstrip("vV") or None
            return resp.text.strip().splitlines()[0].strip().lstrip("vV") or None
    except Exception:
        logger.info("vérification de mise à jour échouée (%s) — ignorée", url)
        return None


@router.get("/version", response_model=VersionView)
async def version(
    request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> VersionView:
    current = __version__
    url = (cfg.get("update_check_url") or "").strip()
    if not url:
        return VersionView(current=current, check_enabled=False)

    # Cache process (URL → dernière version), rafraîchi toutes les 6 h.
    now = time.monotonic()
    cache = getattr(request.app.state, "update_check_cache", None)
    if not cache or cache.get("url") != url or (now - cache.get("ts", 0)) > _CACHE_TTL_SECONDS:
        latest = await _fetch_latest(url, float(request.app.state.settings.glpi_timeout_seconds or 10))
        cache = {"url": url, "ts": now, "latest": latest}
        request.app.state.update_check_cache = cache

    latest = cache.get("latest")
    return VersionView(
        current=current,
        latest=latest,
        update_available=is_newer(latest, current),
        check_enabled=True,
    )
