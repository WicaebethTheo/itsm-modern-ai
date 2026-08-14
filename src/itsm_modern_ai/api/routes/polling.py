"""Déclenchement MANUEL d'un cycle de polling (admin).

Le moteur poll à intervalle fixe (60 s par défaut, réglable). Entre deux cycles, un
exploitant qui vient de brancher GLPI, de coller une clé LLM ou d'élargir le périmètre
n'a aucun moyen de savoir si ça marche : il attend, puis relit la page Statut. Cette
route exécute un cycle TOUT DE SUITE et rend ses compteurs, dans le même format que le
bloc `last_poll` de `GET /api/status` — l'UI n'a donc aucun second contrat à connaître.

Ce n'est PAS une dérogation au pipeline : le cycle déclenché ici est exactement celui du
scheduler (`api/app._run_poll_cycle`), avec les mêmes gardes — plafond de coût, masquage,
whitelist, seuil de confiance, repli « à trier ». Rien n'est court-circuité.

Deux refus explicites plutôt qu'un silence :
- polling en PAUSE → on ne lance rien. La pause est le geste d'arrêt d'urgence du produit
  (licence expirée dont le masquage avancé retombe, fournisseur qui déraille) ; un bouton
  qui la contournerait la viderait de son sens. On renvoie la cause, l'UI propose de
  réactiver.
- cycle DÉJÀ en cours → on ne lance pas un second poller sur la même file (cf. `poll_lock`).
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ...persistence import db
from ...services.runtime_config import RuntimeConfigService
from ..client_ip import client_ip
from ..security import require_auth
from .status import LastPoll, read_last_poll

logger = logging.getLogger("itsm.polling")

router = APIRouter(prefix="/api/polling", tags=["polling"], dependencies=[Depends(require_auth)])


class PollRunResult(BaseModel):
    """Issue du déclenchement + état du cycle, tel que `GET /api/status` le rendrait.

    `outcome` porte la cause d'un non-lancement (`polling_disabled`, `glpi_not_configured`,
    `already_running`) : ce sont les trois raisons pour lesquelles « il ne s'est rien
    passé », et aucune n'est devinable depuis les compteurs — qui, eux, n'auraient tout
    simplement pas bougé.
    """

    outcome: str  # ran | polling_disabled | glpi_not_configured | already_running
    ran: bool
    duration_ms: int
    cycle: LastPoll


@router.post("/run", response_model=PollRunResult)
async def run_now(request: Request) -> PollRunResult:
    """Exécute un cycle MAINTENANT et renvoie ses compteurs.

    L'initiateur est tracé (IP) : un cycle manuel consomme des appels LLM facturés et peut
    écrire dans GLPI ; le journal applicatif doit pouvoir dire qui l'a demandé.
    """
    from ..app import POLL_RAN, _run_poll_cycle

    settings = request.app.state.settings
    trust = bool(getattr(settings, "trust_proxy_headers", False))
    hops = int(getattr(settings, "trusted_proxy_hops", 1))
    initiator = client_ip(request, trust, trusted_hops=hops)

    started = time.perf_counter()
    try:
        outcome = await _run_poll_cycle(request.app)
    except Exception as exc:
        # `poll_once` relaie les plantages inattendus après avoir persisté l'état du cycle
        # (bloc `finally`). On ne les transforme donc pas en 500 : le bloc `cycle` ci-dessous
        # porte déjà le compteur d'erreurs ET le message, et c'est précisément ce que
        # l'exploitant est venu lire. Un 500 lui montrerait une pile à la place.
        outcome = POLL_RAN
        logger.exception("poll manuel (%s) : cycle interrompu par une erreur : %s", initiator, exc)
    duration_ms = int((time.perf_counter() - started) * 1000)
    logger.info("poll manuel déclenché par %s : %s (%d ms)", initiator, outcome, duration_ms)
    # Session NEUVE pour relire les compteurs : le poller les a écrits depuis la sienne, et
    # une session ouverte AVANT le cycle rendrait ses propres objets déjà chargés (carte
    # d'identité SQLAlchemy) — l'UI recevrait alors les compteurs du cycle PRÉCÉDENT en
    # réponse au cycle qu'elle vient de déclencher.
    with db.session_scope() as session:
        cfg = RuntimeConfigService(session, request.app.state.secrets_box, settings)
        cycle = read_last_poll(cfg)
    return PollRunResult(
        outcome=outcome,
        ran=outcome == POLL_RAN,
        duration_ms=duration_ms,
        cycle=cycle,
    )
