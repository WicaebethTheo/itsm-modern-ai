"""Test de bout en bout du fournisseur IA configuré (admin).

`GET /health?probe=true` sonde déjà le fournisseur, mais avec un simple `GET /models` :
ça prouve qu'une URL répond, pas que le modèle rend une Décision exploitable. Or les deux
pannes les plus fréquentes juste après avoir collé une clé ne se voient PAS d'une sonde :

- le modèle nommé n'existe pas chez ce fournisseur (`/models` répond, la complétion non) ;
- le modèle répond, mais pas en JSON conforme au schéma Décision (petit modèle local,
  passerelle qui enrobe la réponse) — le moteur enverra alors tout « à trier », sans que
  rien n'ait l'air en panne.

Cette route fait donc un VRAI appel : le prompt système du produit, un ticket de test, et
la même validation Pydantic qu'en production. C'est le seul test dont un « c'est vert »
signifie « le triage peut fonctionner ».

Le ticket de test est synthétique et constant (aucune PII) : il n'y a rien à masquer. Il
est en revanche journalisé et compté dans le plafond de coût comme tout appel sortant —
un test facturé qui n'apparaîtrait pas au Journal serait une dépense fantôme, exactement
le défaut corrigé sur la Sandbox.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ...domain import masking, prompting
from ...domain.errors import LlmResponseError, LlmTransportError
from ...domain.models import Referentials
from ...persistence import db, journal
from ...services import cost_cap
from ...services.runtime_config import RuntimeConfigService
from ..runtime import FOURNISSEURS_SANS_FACTURATION, build_llm
from ..security import require_auth

logger = logging.getLogger("itsm.llm")

router = APIRouter(prefix="/api/llm", tags=["llm"], dependencies=[Depends(require_auth)])

# Périmètre FICTIF du test — jamais celui de l'instance. Deux raisons : le test doit
# fonctionner sur une instance neuve (aucune catégorie encore sélectionnée, sinon il
# échouerait pour une raison sans rapport avec le fournisseur), et un périmètre réel
# ferait varier la taille du prompt donc le coût du test d'une instance à l'autre.
_TEST_REFS = Referentials(
    categories={1: "Compte / Authentification", 2: "Materiel"},
    technicians={11: "Technicien de test"},
)
_TEST_TICKET = (
    "Bonjour, depuis ce matin je n'arrive plus a ouvrir ma session sur mon poste de "
    "travail : le mot de passe est refuse. Merci de votre aide."
)
_ERROR_MESSAGE_MAX_CHARS = 300  # même borne que `_detail_sur` (routes/debug.py)

# Issues du test. Vocabulaire aligné sur celui du moteur (`TriageReason.invalid_output`) :
# une sortie non conforme constatée ici est LE MÊME défaut que celui qui enverra les
# tickets « à trier » en production, et doit donc porter le même nom.
STAGE_OK = "ok"
STAGE_NOT_CONFIGURED = "not_configured"
STAGE_UNREACHABLE = "unreachable"
STAGE_INVALID_OUTPUT = "invalid_output"
STAGE_COST_CAP = "cost_cap_reached"
STAGE_ERROR = "error"


class LlmTestResult(BaseModel):
    """Verdict du test. `ok` n'est vrai que si une Décision valide a été obtenue."""

    ok: bool
    stage: str
    provider: str
    model: str = ""
    latency_ms: int | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    cost_eur: float | None = None
    # Ce que le modèle a effectivement proposé sur le ticket de test — la preuve qu'il a
    # compris la consigne, pas seulement qu'il a répondu quelque chose.
    category: int | None = None
    priority: int | None = None
    confidence: float | None = None
    error: str | None = None


def _short(text: str) -> str:
    """Message d'erreur masqué et borné — un diagnostic ne doit jamais fuiter une clé.

    `network=False` : sur un déploiement on-premise, l'hôte et l'IP SONT le diagnostic
    (mauvais port, VLAN fermé) — même arbitrage que `scheduler/poller._short_reason`.
    """
    clean = masking.mask(text, network=False).text
    if len(clean) <= _ERROR_MESSAGE_MAX_CHARS:
        return clean
    return clean[:_ERROR_MESSAGE_MAX_CHARS].rstrip() + "…"


@router.post("/test", response_model=LlmTestResult)
async def test_llm(request: Request) -> LlmTestResult:
    """Appelle le fournisseur configuré avec un ticket de test et rend un verdict.

    Répond 200 dans TOUS les cas de diagnostic (fournisseur absent, injoignable, sortie
    non conforme, plafond atteint) : c'est une route dont l'échec du sujet est le résultat
    attendu. Un 4xx/5xx obligerait l'UI à traduire un code HTTP en cause métier, et
    afficherait « erreur d'API » là où la seule information utile est « le modèle
    `mistral-tiny` n'existe pas chez ce fournisseur ».
    """
    settings = request.app.state.settings
    secrets = request.app.state.secrets_box

    with db.session_scope() as session:
        cfg = RuntimeConfigService(session, secrets, settings)
        provider = cfg.get("llm_provider") or settings.llm_provider
        cap = cfg.get_float("cost_cap_eur_per_day", settings.cost_cap_eur_per_day)
        price_in = cfg.get_float("llm_price_input_per_mtok", settings.llm_price_input_per_mtok)
        price_out = cfg.get_float("llm_price_output_per_mtok", settings.llm_price_output_per_mtok)
        over_cap = cost_cap.is_over_cap(session, cap)
    # Un fournisseur local ne facture rien : lui appliquer un tarif inventerait une dépense
    # (même arbitrage que `api/runtime.build_triage_service`).
    if provider in FOURNISSEURS_SANS_FACTURATION:
        price_in = price_out = 0.0

    llm = build_llm(settings, secrets)
    if llm is None:
        return LlmTestResult(ok=False, stage=STAGE_NOT_CONFIGURED, provider=provider)
    model = getattr(llm, "model", "")

    # Plafond atteint : le moteur ne passe plus un seul appel facturable. Tester quand même
    # dépenserait sur un budget déjà clos — et rendrait un verdict que l'instance ne pourra
    # de toute façon pas honorer sur ses vrais tickets.
    if over_cap and price_in + price_out > 0:
        return LlmTestResult(
            ok=False, stage=STAGE_COST_CAP, provider=provider, model=model,
            error="Plafond de coût quotidien atteint : aucun appel facturable n'est passé.",
        )

    user_prompt = prompting.build_user_prompt(_TEST_TICKET, _TEST_REFS, "(test de connexion)")
    started = time.perf_counter()
    stage, error, result = STAGE_OK, None, None
    try:
        result = await llm.complete(prompting.SYSTEM_PROMPT, user_prompt)
    except LlmTransportError as exc:
        stage, error = STAGE_UNREACHABLE, _short(str(exc))
    except LlmResponseError as exc:
        stage, error = STAGE_INVALID_OUTPUT, _short(str(exc))
    except Exception as exc:  # filet : un test ne doit jamais rendre une pile à l'UI
        stage, error = STAGE_ERROR, _short(f"{type(exc).__name__}: {exc}")
        logger.exception("test du fournisseur IA (%s) : échec inattendu", provider)
    latency_ms = int((time.perf_counter() - started) * 1000)

    cost = None
    if result is not None:
        cost = cost_cap.cost_eur(result.prompt_tokens, result.completion_tokens, price_in, price_out)
        # Journalisé comme tout appel sortant (FR-19) : `ticket_id=0` marque une décision
        # hors-ticket, comme la Sandbox. Le prompt est constant et synthétique — il est donc
        # écrit tel quel, sans passe de masquage à laquelle il n'y aurait rien à masquer.
        with db.session_scope() as session:
            journal.record_llm_call(
                session,
                ticket_id=0,
                model=result.model,
                prompt_sent=user_prompt,
                response_received=result.raw_response,
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens,
                cost_eur=cost,
            )

    decision = result.decision if result is not None else None
    logger.info(
        "test du fournisseur IA %s (%s) : %s en %d ms", provider, model or "?", stage, latency_ms
    )
    return LlmTestResult(
        ok=stage == STAGE_OK,
        stage=stage,
        provider=provider,
        model=result.model if result is not None else model,
        latency_ms=latency_ms,
        prompt_tokens=result.prompt_tokens if result is not None else None,
        completion_tokens=result.completion_tokens if result is not None else None,
        cost_eur=cost,
        category=decision.category if decision is not None else None,
        priority=decision.priority if decision is not None else None,
        confidence=decision.confidence if decision is not None else None,
        error=error,
    )
