"""Version courante du moteur + vérification de mise à jour — OPT-IN, souverain.

Par défaut, `update_check_url` est vide → AUCUN appel sortant (air-gap / souveraineté
respectés) : l'endpoint ne renvoie que la version courante. Si une URL est configurée,
le moteur l'interroge (best-effort, mis en cache) pour savoir si une version plus récente
existe. Le flux doit renvoyer du JSON {"version": "x.y.z"} (ou {"tag_name": ...}) ou la
version en texte brut.
"""

from __future__ import annotations

import logging
import os
import time

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ... import __version__
from ...adapters.llm._http import make_guarded_event_hooks
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service
from ..security import require_auth

logger = logging.getLogger("itsm.version")
router = APIRouter(prefix="/api", tags=["version"], dependencies=[Depends(require_auth)])


class VersionView(BaseModel):
    current: str
    latest: str | None = None
    update_available: bool = False
    check_enabled: bool = False  # une URL de vérification est-elle configurée ?
    latest_notes: str | None = None  # notes de release (description du flux), si dispo
    runtime: str = "host"  # « docker » (conteneur) ou « host » (installé direct) → MAJ adaptée


def detect_runtime() -> str:
    """« docker » si le moteur tourne en conteneur, « host » sinon.

    Le signal explicite `ITSM_RUNTIME` (posé dans l'image Docker via `ENV`) prime ; à
    défaut on retombe sur les marqueurs génériques de conteneur (`/.dockerenv`, cgroup).
    Sert à afficher l'indicateur du top bar ET à proposer la bonne commande de MAJ
    (`docker compose pull …` en conteneur vs `./install.sh --update` sur l'hôte).
    """
    explicit = os.environ.get("ITSM_RUNTIME", "").strip().lower()
    if explicit:
        return explicit
    if os.path.exists("/.dockerenv"):
        return "docker"
    try:
        with open("/proc/1/cgroup", encoding="utf-8") as fh:
            if any(marker in fh.read() for marker in ("docker", "containerd", "kubepods")):
                return "docker"
    except OSError:
        pass
    return "host"


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
        a, b = _parse(latest), _parse(current)
        n = max(len(a), len(b))  # pad pour comparer 1.0 et 1.0.0 sans faux positif
        a += (0,) * (n - len(a))
        b += (0,) * (n - len(b))
        return a > b
    except Exception:  # pragma: no cover - défensif
        return False


async def _fetch_latest(url: str, timeout: float, *, guard: bool) -> dict | None:
    """Dernière version publiée + notes (best-effort). None si indisponible.

    Renvoie {"version": "x.y.z", "notes": str | None}.

    Durcissement SSRF : le même garde anti-rebinding que les clients LLM/GLPI est posé
    en `event_hooks` (il refire à CHAQUE saut de redirection) → une `update_check_url`
    pointée sur un hôte interne / IMDS (169.254.169.254) est refusée à l'exécution.
    """
    hooks = make_guarded_event_hooks(guard=guard, allow_local=False)
    try:
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=True, event_hooks=hooks or {}
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype:
                data = resp.json()
                # GitLab /releases renvoie un TABLEAU (plus récent en tête) ; GitHub
                # /releases/latest renvoie un objet. On gère les deux.
                if isinstance(data, list):
                    data = data[0] if data else {}
                if not isinstance(data, dict):
                    return None
                ver = str(data.get("version") or data.get("tag_name") or "").strip().lstrip("vV")
                if not ver:
                    return None
                # GitLab : "description" ; GitHub : "body".
                notes = data.get("description") or data.get("body") or None
                return {"version": ver, "notes": str(notes) if notes else None}
            ver = resp.text.strip().splitlines()[0].strip().lstrip("vV")
            return {"version": ver, "notes": None} if ver else None
    except Exception:
        logger.info("vérification de mise à jour échouée (%s) — ignorée", url)
        return None


@router.get("/version", response_model=VersionView)
async def version(
    request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> VersionView:
    current = __version__
    runtime = detect_runtime()
    url = (cfg.get("update_check_url") or "").strip()
    if not url:
        return VersionView(current=current, check_enabled=False, runtime=runtime)

    # Cache process (URL → dernière version), rafraîchi selon update_check_ttl_seconds.
    ttl = max(60, int(request.app.state.settings.update_check_ttl_seconds))
    now = time.monotonic()
    cache = getattr(request.app.state, "update_check_cache", None)
    if not cache or cache.get("url") != url or (now - cache.get("ts", 0)) > ttl:
        info = await _fetch_latest(
            url,
            float(request.app.state.settings.glpi_timeout_seconds or 10),
            guard=request.app.state.settings.ssrf_guard_enabled,
        )
        cache = {"url": url, "ts": now, "info": info}
        request.app.state.update_check_cache = cache

    info = cache.get("info") or {}
    latest = info.get("version")
    return VersionView(
        current=current,
        latest=latest,
        update_available=is_newer(latest, current),
        check_enabled=True,
        latest_notes=info.get("notes"),
        runtime=runtime,
    )
