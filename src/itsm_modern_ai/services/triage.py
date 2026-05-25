"""Pipeline à deux étages + moteur à garde-fous (mode suggestion).

ORDRE IMMUABLE (project-context.md invariant 1) :
    [étage 1 : règles GLPI déjà appliquées ?] → cost cap (FR-10) → Masquage (FR-14)
    → appel LLM JSON mode + retry (FR-6/9/11) → validation Pydantic (frontière adaptateur)
    → validation Whitelist (FR-7) → seuil de confiance (FR-8) → dépôt Suivi / « à trier ».

« à trier » est la SEULE échappatoire (invariant 3). Mode suggestion : on n'écrit qu'un
Suivi interne privé, jamais un champ de Ticket (FR-17). Veto technicien implicite : rien
n'est appliqué sans action humaine, aucun rejet humain n'est enregistré (FR-18).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import AbstractContextManager

from sqlmodel import Session

from ..config.settings import Settings
from ..domain import engine, masking, prompting
from ..domain.errors import LlmResponseError, LlmTransportError
from ..domain.models import (
    Priority,
    Referentials,
    Ticket,
    TriageOutcome,
    TriageReason,
)
from ..persistence import journal
from ..ports.itsm import ItsmPort
from ..ports.llm import LlmPort, LlmResult
from . import cost_cap

logger = logging.getLogger("itsm.triage")

SessionFactory = Callable[[], AbstractContextManager[Session]]


def rules_fully_handled(ticket: Ticket) -> bool:
    """Étage 1 (FR-5) : le Ticket est-il DÉJÀ traité par les règles GLPI ?

    Décision de design (Q16, PRD §16.7) : « traité » = catégorie ET technicien posés.
    Un Ticket partiellement matché (catégorie sans assignation, ou l'inverse) est
    considéré NON complètement traité → passe au Moteur pour les champs manquants.
    """
    return ticket.category_id > 0 and ticket.assignee_present


def _web_link(glpi_base_url: str, ticket_id: int) -> str:
    base = glpi_base_url.rstrip("/")
    for suffix in ("/apirest.php", "/api.php"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return f"{base}/front/ticket.form.php?id={ticket_id}" if base else ""


def render_followup(outcome: TriageOutcome, refs: Referentials) -> str:
    """Contenu du Suivi interne privé (français, lisible par le technicien)."""
    d = outcome.decision
    assert d is not None
    cat = refs.categories.get(d.category, str(d.category))
    try:
        prio = f"{Priority(d.priority).name} (#{d.priority})"
    except ValueError:
        prio = str(d.priority)
    # Routage : technicien si éligible, sinon groupe (fallback).
    if d.technician_id is not None and d.technician_id in refs.technicians:
        assignee = f"Technicien {refs.technicians[d.technician_id]} (#{d.technician_id})"
    elif d.group_id is not None:
        assignee = f"Groupe {refs.groups.get(d.group_id, str(d.group_id))} (#{d.group_id})"
    else:
        assignee = "—"
    return (
        "🤖 Suggestion de triage — ITSM Modern AI (proposition, non appliquée)\n"
        f"• Catégorie proposée : {cat} (#{d.category})\n"
        f"• Priorité proposée : {prio}\n"
        f"• Affectation suggérée : {assignee}\n"
        f"• Confiance : {d.confidence:.0%}\n\n"
        "Brouillon de réponse (à valider, jamais envoyé automatiquement) :\n"
        f"{d.draft}\n\n"
        "— Vous gardez la main : ignorer cette suggestion n'est ni bloqué ni enregistré."
    )


class TriageService:
    def __init__(
        self,
        *,
        itsm: ItsmPort | None,
        llm: LlmPort,
        settings: Settings,
        tech_profiles_prose: str,
        session_factory: SessionFactory,
        guidance: str = "",
        retries: int | None = None,
        system_prompt: str = "",
    ) -> None:
        self._itsm = itsm
        self._llm = llm
        self._settings = settings
        self._profiles = tech_profiles_prose
        self._session_factory = session_factory
        self._guidance = guidance
        self._retries = settings.llm_retries if retries is None else retries
        # Vide → prompt système par défaut intégré.
        self._system_prompt = system_prompt.strip() or prompting.SYSTEM_PROMPT

    async def _call_llm(self, system: str, user: str) -> LlmResult:
        """Appel LLM avec retry borné (FR-9) sur erreur transport."""
        last: Exception | None = None
        for _ in range(self._retries + 1):
            try:
                return await self._llm.complete(system, user)
            except LlmTransportError as exc:
                last = exc
        raise last  # type: ignore[misc]

    async def evaluate_text(
        self, ticket_id: int, raw_text: str, refs: Referentials
    ) -> tuple[TriageOutcome, LlmResult | None]:
        """Masquage → LLM → Pydantic → Whitelist → seuil. N'écrit RIEN (sandbox-safe)."""
        masked = masking.mask(raw_text)
        system = self._system_prompt
        user = prompting.build_user_prompt(masked.text, refs, self._profiles, self._guidance)
        try:
            result = await self._call_llm(system, user)
        except LlmResponseError:
            return TriageOutcome(accepted=False, reason=TriageReason.INVALID_OUTPUT), None
        except LlmTransportError:
            return TriageOutcome(accepted=False, reason=TriageReason.LLM_ERROR), None

        outcome = engine.evaluate(result.decision, refs, self._settings.confidence_threshold)
        return outcome, result

    async def handle(self, ticket: Ticket, refs: Referentials) -> bool:
        """Handler du poller. Renvoie True si un Suivi a été écrit."""
        # Étage 1 (FR-5) : déjà traité par une règle GLPI → pas d'appel LLM.
        if rules_fully_handled(ticket):
            logger.info("ticket %s déjà traité par règle GLPI → skip moteur", ticket.id)
            return False

        # Cost cap (FR-10) AVANT tout appel facturant.
        with self._session_factory() as session:
            if cost_cap.is_over_cap(session, self._settings.cost_cap_eur_per_day):
                journal.record_decision(
                    session, ticket.id,
                    TriageOutcome(accepted=False, reason=TriageReason.COST_CAP_REACHED),
                )
                logger.warning("cost cap atteint → ticket %s en « à trier »", ticket.id)
                return False

        raw_text = f"{ticket.title}\n{ticket.content}".strip()
        outcome, result = await self.evaluate_text(ticket.id, raw_text, refs)

        # Journalisation de l'appel LLM (FR-19) — contenu masqué, coût pour le cap.
        if result is not None:
            price_in = self._settings.llm_price_input_per_mtok
            price_out = self._settings.llm_price_output_per_mtok
            with self._session_factory() as session:
                journal.record_llm_call(
                    session,
                    ticket_id=ticket.id,
                    model=result.model,
                    prompt_sent=masking.mask(raw_text).text,
                    response_received=result.raw_response,
                    prompt_tokens=result.prompt_tokens,
                    completion_tokens=result.completion_tokens,
                    cost_eur=cost_cap.cost_eur(
                        result.prompt_tokens, result.completion_tokens, price_in, price_out
                    ),
                )

        glpi_link = _web_link(self._settings.glpi_base_url, ticket.id)
        wrote = False
        if outcome.accepted:
            if self._itsm is None:
                raise RuntimeError("handle() requiert un ItsmPort pour écrire le Suivi")
            content = render_followup(outcome, refs)
            await self._itsm.write_followup(ticket.id, content, private=True)  # FR-4/17
            wrote = True

        with self._session_factory() as session:
            journal.record_decision(session, ticket.id, outcome, glpi_link=glpi_link)
        return wrote
