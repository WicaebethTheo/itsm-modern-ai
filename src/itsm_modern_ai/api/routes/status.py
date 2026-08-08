"""Statut runtime du moteur (FR-27, observabilité minimale) + compteurs (FR-10).

Endpoint PUBLIC (l'installeur sonde `GET /api/status` et attend un 200 sans auth) mais à
réponse À DEUX NIVEAUX (durcissement audit 2026-06) : sans session admin, seul l'état de
marche est exposé (ok, version, polling) ; compteurs LLM, coût 24 h, plafond et volumétrie
des référentiels ne sont renvoyés QUE si la requête est authentifiée — sinon n'importe qui
sur le réseau lirait la consommation et la volumétrie de l'instance.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, model_serializer
from sqlmodel import Session

from ...persistence import journal
from ...services import cost_cap
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_session
from ..security import session_is_authenticated

router = APIRouter(prefix="/api", tags=["status"])


_ERROR_MESSAGE_MAX_CHARS = 300  # même borne que `_detail_sur` (routes/debug.py)


class LastPoll(BaseModel):
    """État du DERNIER cycle de polling — bloc de diagnostic (session admin UNIQUEMENT).

    `PollStats` n'existait que le temps d'un `logger.info` : la seule façon de répondre à
    « pourquoi aucun ticket n'est trié ? » était d'ouvrir `docker logs`. Le poller persiste
    désormais ces compteurs dans `RuntimeConfig` (clés `poll_last_*`), et on les rend ici.

    « Aucun cycle n'a jamais tourné » est le symptôme n°1 à rendre visible (worker affiché
    « En marche » alors que rien ne s'est exécuté). On l'exprime par `has_run: false` — un
    booléen NON nul, qui survit à `response_model_exclude_none=True` — plutôt que par un
    `last_poll: null` que ce même filtrage ferait disparaître, rendant « jamais exécuté »
    indiscernable de « ce moteur n'expose pas encore le bloc ». La réponse ANONYME, elle,
    n'a toujours aucune clé `last_poll` : le niveau public reste inchangé.
    """

    has_run: bool = False  # un cycle a-t-il déjà été exécuté ?
    run_at: str | None = None  # ISO 8601 UTC
    fetched: int = 0
    processed: int = 0
    skipped_done: int = 0
    skipped_scope: int = 0
    errors: int = 0
    error_message: str | None = None

    @model_serializer
    def _serialize(self) -> dict[str, object]:
        """Sérialisation EXPLICITE : les clés du bloc sont toujours présentes.

        La route est en `response_model_exclude_none=True` (c'est ce qui garde la réponse
        publique minimale), et cette exclusion est RÉCURSIVE : sans ce sérialiseur,
        `error_message: null` disparaîtrait du bloc. Or « pas d'erreur » est une
        information, pas une absence de champ — le contrat rendu à l'UI est stable.
        """
        return {
            "has_run": self.has_run,
            "run_at": self.run_at,
            "fetched": self.fetched,
            "processed": self.processed,
            "skipped_done": self.skipped_done,
            "skipped_scope": self.skipped_scope,
            "errors": self.errors,
            "error_message": self.error_message,
        }


class Status(BaseModel):
    # Partie publique : strict état de marche.
    ok: bool = True
    version: str
    polling_enabled: bool
    # Partie enrichie (session admin uniquement) : None → champ omis de la réponse.
    polling_interval_seconds: int | None = None
    whitelist_loaded: bool | None = None
    categories_count: int | None = None
    technicians_count: int | None = None
    llm_calls_total: int | None = None
    cost_eur_last_24h: float | None = None
    cost_cap_eur_per_day: float | None = None
    # Bloc de diagnostic du dernier cycle — jamais exposé à un anonyme (volumétrie et
    # message d'erreur = reconnaissance offerte). Absent = appelant non authentifié ;
    # présent avec `has_run: false` = authentifié, aucun cycle encore exécuté.
    last_poll: LastPoll | None = None


@router.get("/status", response_model=Status, response_model_exclude_none=True)
def status(request: Request, session: Session = Depends(get_session)) -> Status:
    from ... import __version__

    settings = request.app.state.settings
    # Valeurs RUNTIME (surcharges UI en base), pas les seules valeurs d'env : sinon une
    # pause du polling depuis la console serait invisible ici (incohérence env vs runtime).
    cfg = RuntimeConfigService(session, request.app.state.secrets_box, settings)
    body = Status(
        version=__version__,
        polling_enabled=cfg.get_bool("polling_enabled", settings.polling_enabled),
    )
    if not session_is_authenticated(request):
        return body  # réponse publique minimale (installeur, sonde réseau)

    cache = request.app.state.whitelist_cache
    refs = cache.referentials
    body.polling_interval_seconds = cfg.get_int(
        "polling_interval_seconds", settings.polling_interval_seconds
    )
    body.whitelist_loaded = cache.is_loaded
    body.categories_count = len(refs.categories)
    body.technicians_count = len(refs.technicians)
    body.llm_calls_total = journal.count_llm_calls(session)
    body.cost_eur_last_24h = round(cost_cap.spent_last_24h(session), 4)
    body.cost_cap_eur_per_day = cfg.get_float("cost_cap_eur_per_day", settings.cost_cap_eur_per_day)
    body.last_poll = _last_poll(cfg)
    return body


def _last_poll(cfg: RuntimeConfigService) -> LastPoll:
    """Relit l'état du dernier cycle persisté par le poller.

    Renvoie TOUJOURS un objet : `has_run=False` est l'état explicite « aucun cycle n'a
    jamais tourné », lisible tel quel par l'UI (cf. docstring de `LastPoll`).
    """
    run_at = cfg.get("poll_last_run_at")
    if not run_at:
        return LastPoll()
    # Le message est déjà masqué et borné à l'écriture (`scheduler/poller.py`) ; on
    # re-borne ici par principe : un champ de diagnostic ne doit jamais devenir un
    # canal de fuite, quelle que soit la façon dont la valeur est arrivée en base.
    message = (cfg.get("poll_last_error_message") or "").strip()
    if len(message) > _ERROR_MESSAGE_MAX_CHARS:
        message = message[:_ERROR_MESSAGE_MAX_CHARS].rstrip() + "…"
    return LastPoll(
        has_run=True,
        run_at=run_at,
        fetched=cfg.get_int("poll_last_fetched", 0),
        processed=cfg.get_int("poll_last_processed", 0),
        skipped_done=cfg.get_int("poll_last_skipped_done", 0),
        skipped_scope=cfg.get_int("poll_last_skipped_scope", 0),
        errors=cfg.get_int("poll_last_errors", 0),
        error_message=message or None,
    )
