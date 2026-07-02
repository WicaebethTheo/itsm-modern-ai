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

import html as _html
import logging
from collections.abc import Callable
from contextlib import AbstractContextManager

import anyio
from sqlmodel import Session

from ..config.settings import Settings
from ..domain import engine, masking, prompting, whitelist
from ..domain.errors import LlmResponseError, LlmTransportError
from ..domain.models import (
    Priority,
    Referentials,
    Ticket,
    TriageOutcome,
    TriageReason,
)
from ..domain.modes import ExecutionMode, resolve_action
from ..persistence import journal
from ..ports.itsm import ItsmPort
from ..ports.llm import LlmPort, LlmResult
from . import cost_cap, referentials
from .links import ticket_web_link as _web_link  # lien front GLPI (factorisé dans links.py)

logger = logging.getLogger("itsm.triage")

SessionFactory = Callable[[], AbstractContextManager[Session]]

# Garde-fou de longueur du brouillon publié au demandeur (modes auto). Borne défensive
# contre un draft LLM anormalement long (prompt injection / boucle) posté publiquement.
PUBLIC_DRAFT_MAX_CHARS = 4000

# Backoff court entre deux retries LLM (FR-9) : re-frapper immédiatement un fournisseur
# en 429/erreur transitoire ne laisse aucune chance au retry d'aboutir. Le dernier palier
# est réutilisé si `llm_retries` dépasse la table. `anyio.sleep` → n'immobilise pas l'event
# loop (le poller continue). Alias module (`_sleep`) monkeypatchable en test.
LLM_RETRY_BACKOFF_S: tuple[float, ...] = (0.5, 1.5)
_sleep = anyio.sleep


def rules_fully_handled(ticket: Ticket) -> bool:
    """Étage 1 (FR-5) : le Ticket est-il DÉJÀ traité par les règles GLPI ?

    Décision de design (Q16, PRD §16.7) : « traité » = catégorie ET technicien posés.
    Un Ticket partiellement matché (catégorie sans assignation, ou l'inverse) est
    considéré NON complètement traité → passe au Moteur pour les champs manquants.
    """
    return ticket.category_id > 0 and ticket.assignee_present


def render_followup(outcome: TriageOutcome, refs: Referentials, *, applied: bool = False) -> str:
    """Contenu du Suivi déposé sur le Ticket.

    Deux cas, selon le mode :
    - `applied=True` (semi/full-auto, Décision appliquée) → **réponse publique au demandeur** :
      uniquement le brouillon de réponse, sans annotation de triage interne.
    - `applied=False` (suggestion) → **Suivi interne privé annoté** : triage proposé + brouillon
      à valider, jamais envoyé. Le technicien garde la main.
    """
    d = outcome.decision
    assert d is not None
    # Le brouillon est une sortie LLM NON FIABLE : un demandeur peut prompt-injecter du
    # markup. GLPI rend le contenu d'un suivi en HTML → on échappe le brouillon AVANT de
    # l'insérer, dans les deux modes (public au demandeur ET privé lu par le technicien).
    # On n'échappe QUE la partie non fiable, jamais le gabarit interne de confiance.
    safe_draft = _html.escape(d.draft)
    if applied:
        # Modes auto : l'IA répond directement au demandeur (Suivi public, brouillon seul).
        return safe_draft

    cat = refs.categories.get(d.category, str(d.category))
    try:
        prio = f"{Priority(d.priority).name} (#{d.priority})"
    except ValueError:
        prio = str(d.priority)
    # Routage : MÊME assignation filtrée que celle appliquée à GLPI (whitelist.effective_
    # assignment) → le Suivi ne peut pas afficher un acteur différent de la mutation réelle.
    tech_id, group_id = whitelist.effective_assignment(d, refs)
    if tech_id is not None:
        assignee = f"Technicien {refs.technicians[tech_id]} (#{tech_id})"
    elif group_id is not None:
        assignee = f"Groupe {refs.groups.get(group_id, str(group_id))} (#{group_id})"
    else:
        assignee = "—"
    return (
        "🤖 Suggestion de triage — ITSM Modern AI (proposition, non appliquée)\n"
        f"• Catégorie proposée : {cat} (#{d.category})\n"
        f"• Priorité proposée : {prio}\n"
        f"• Affectation suggérée : {assignee}\n"
        f"• Confiance : {d.confidence:.0%}\n\n"
        "Brouillon de réponse (à valider, jamais envoyé automatiquement) :\n"
        f"{safe_draft}\n\n"
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
        default_mode: ExecutionMode = ExecutionMode.SUGGESTION,
        auto_min_confidence: float | None = None,
        mask_flags: dict[str, bool] | None = None,
        advanced_masker=None,  # passe Supporter (FEATURE_PII_ADVANCED) appliquée après le masque de base
        glpi_base_url: str | None = None,
        confidence_threshold: float | None = None,
        cost_cap_eur_per_day: float | None = None,
    ) -> None:
        self._itsm = itsm
        self._llm = llm
        self._settings = settings
        # Seuil de confiance (FR-8) et plafond de coût/jour (FR-10) résolus runtime (UI > .env) :
        # sinon une modification depuis la console serait ignorée par le moteur.
        self._confidence_threshold = (
            settings.confidence_threshold if confidence_threshold is None else confidence_threshold
        )
        self._cost_cap_eur_per_day = (
            settings.cost_cap_eur_per_day if cost_cap_eur_per_day is None else cost_cap_eur_per_day
        )
        # URL GLPI courante (config runtime via l'UI ; .env n'est qu'un repli). Sert à figer
        # le lien front du Ticket dans le Journal au moment de la décision.
        self._glpi_base_url = settings.glpi_base_url if glpi_base_url is None else glpi_base_url
        self._profiles = tech_profiles_prose
        self._session_factory = session_factory
        self._guidance = guidance
        self._retries = settings.llm_retries if retries is None else retries
        # Vide → prompt système par défaut intégré.
        self._system_prompt = system_prompt.strip() or prompting.SYSTEM_PROMPT
        # Mode d'exécution par défaut (les entités peuvent surcharger) + 2e seuil semi-auto.
        self._default_mode = default_mode
        self._auto_min_confidence = (
            settings.auto_min_confidence_default if auto_min_confidence is None else auto_min_confidence
        )
        # Motifs de masquage actifs (FR-14). Vide → tous actifs (défaut sûr).
        self._mask_flags = mask_flags or {}
        # Masquage avancé Supporter (NIR/SIRET, regex custom) — None sans licence valide.
        self._advanced_masker = advanced_masker

    def _advanced(self, text: str) -> str:
        """Passe de masquage Supporter après le masque de base (no-op sans licence)."""
        return self._advanced_masker.mask(text) if self._advanced_masker is not None else text

    async def _call_llm(self, system: str, user: str) -> LlmResult:
        """Appel LLM avec retry borné (FR-9) + backoff court.

        On retente aussi bien les erreurs de transport (réseau/429) que les réponses
        invalides (`LlmResponseError` : JSON malformé, schéma KO, `content: null` d'un
        filtre de contenu) — la docstring de `LlmResponseError` promet « après retry »,
        et une sortie non conforme est souvent transitoire (bavardage, troncature).
        """
        last: Exception | None = None
        for attempt in range(self._retries + 1):
            if attempt:  # jamais avant le 1er essai — uniquement entre deux tentatives
                await _sleep(LLM_RETRY_BACKOFF_S[min(attempt - 1, len(LLM_RETRY_BACKOFF_S) - 1)])
            try:
                return await self._llm.complete(system, user)
            except (LlmTransportError, LlmResponseError) as exc:
                last = exc
        raise last  # type: ignore[misc]

    async def evaluate_text(
        self, ticket_id: int, raw_text: str, refs: Referentials
    ) -> tuple[TriageOutcome, LlmResult | None]:
        """Masquage → LLM → Pydantic → Whitelist → seuil. N'écrit RIEN (sandbox-safe)."""
        masked = masking.mask(raw_text, **self._mask_flags)
        system = self._system_prompt
        user = prompting.build_user_prompt(
            self._advanced(masked.text), refs, self._profiles, self._guidance
        )
        try:
            result = await self._call_llm(system, user)
        except LlmResponseError as exc:
            # Sortie LLM invalide après garde-fous (JSON malformé, schéma KO). Tracé pour
            # diagnostiquer côté admin sans exposer le détail au client.
            logger.warning("triage: réponse LLM invalide (ticket=%s): %s", ticket_id, exc)
            return TriageOutcome(accepted=False, reason=TriageReason.INVALID_OUTPUT), None
        except LlmTransportError as exc:
            # Réseau/clé/quota : visible dans les logs pour qualifier la panne — la sandbox
            # ne remontait qu'un `reason=llm_error` opaque sans la cause exacte.
            logger.warning("triage: appel LLM échoué (ticket=%s): %s", ticket_id, exc)
            return TriageOutcome(accepted=False, reason=TriageReason.LLM_ERROR), None

        outcome = engine.evaluate(result.decision, refs, self._confidence_threshold)
        return outcome, result

    async def handle(self, ticket: Ticket, refs: Referentials) -> bool:
        """Handler du poller. Renvoie True si un Suivi a été écrit.

        Orchestration à ordre immuable (cf. docstring du module) ; chaque étape est
        déléguée à une méthode dédiée pour la lisibilité, sans changer l'enchaînement.
        """
        # Étage 1 (FR-5) : déjà traité par une règle GLPI → pas d'appel LLM.
        if rules_fully_handled(ticket):
            logger.info("ticket %s déjà traité par règle GLPI → skip moteur", ticket.id)
            return False

        # Cost cap (FR-10) AVANT tout appel facturant.
        if self._cost_cap_reached(ticket):
            return False

        raw_text = f"{ticket.title}\n{ticket.content}".strip()
        outcome, result = await self.evaluate_text(ticket.id, raw_text, refs)

        if result is not None:
            self._journal_llm_call(ticket, raw_text, result)

        return await self._persist_outcome(ticket, outcome, refs)

    def _cost_cap_reached(self, ticket: Ticket) -> bool:
        """Cost cap (FR-10) : True si atteint. Journalise alors « à trier »."""
        with self._session_factory() as session:
            if cost_cap.is_over_cap(session, self._cost_cap_eur_per_day):
                journal.record_decision(
                    session, ticket.id,
                    TriageOutcome(accepted=False, reason=TriageReason.COST_CAP_REACHED),
                    subject=ticket.title,
                )
                logger.warning("cost cap atteint → ticket %s en « à trier »", ticket.id)
                return True
        return False

    def _journal_llm_call(self, ticket: Ticket, raw_text: str, result: LlmResult) -> None:
        """Journalise l'appel LLM (FR-19) — contenu masqué, coût pour le cap."""
        price_in = self._settings.llm_price_input_per_mtok
        price_out = self._settings.llm_price_output_per_mtok
        with self._session_factory() as session:
            journal.record_llm_call(
                session,
                ticket_id=ticket.id,
                model=result.model,
                prompt_sent=self._advanced(masking.mask(raw_text, **self._mask_flags).text),
                response_received=result.raw_response,
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens,
                cost_eur=cost_cap.cost_eur(
                    result.prompt_tokens, result.completion_tokens, price_in, price_out
                ),
            )

    async def _persist_outcome(
        self, ticket: Ticket, outcome: TriageOutcome, refs: Referentials
    ) -> bool:
        """Applique la Décision selon le mode du périmètre, puis journalise (FR-17).

        Mode du périmètre (par entité, défaut global) → `resolve_action` :
        - suggestion → Suivi privé seul (aucune mutation) ;
        - semi/full-auto → mutation GLPI (`apply_decision`) PUIS Suivi privé (audit).
        Le garde-fou (whitelist + seuil) a déjà tranché en amont ; ici on ne fait
        QUE dispatcher l'action d'une Décision acceptée. « à trier » ne fait rien.
        """
        glpi_link = _web_link(self._glpi_base_url, ticket.id)
        mode = self._default_mode
        applied = False
        wrote = False

        if outcome.accepted:
            if self._itsm is None:
                raise RuntimeError("handle() requiert un ItsmPort pour agir sur le Ticket")
            with self._session_factory() as session:
                mode, auto_threshold = referentials.mode_for_entity(
                    session,
                    ticket.entity_id,
                    default_mode=self._default_mode,
                    default_auto_min_confidence=self._auto_min_confidence,
                )
            action = resolve_action(outcome, mode, auto_threshold)
            d = outcome.decision
            assert d is not None
            # FR-7 : n'appliquer QUE des acteurs éligibles (le LLM peut proposer un
            # technicien hors périmètre à côté d'un groupe valide). Même valeur pour la
            # mutation et le Suivi → pas de divergence GLPI/Journal.
            tech_id, group_id = whitelist.effective_assignment(d, refs)
            if action.apply:  # modes semi/full-auto : mutation réelle du Ticket
                # Si apply échoue : rien n'a été muté → on laisse l'exception remonter
                # (ticket non marqué « traité », repris au cycle suivant, sans état partiel).
                await self._itsm.apply_decision(
                    ticket.id,
                    category=d.category,
                    priority=d.priority,
                    technician_id=tech_id,
                    group_id=group_id,
                )
                applied = True
            if action.write_followup:  # toujours pour une Décision acceptée
                # Le Suivi est un acte SECONDAIRE. Si la mutation a déjà eu lieu (applied),
                # une exception ici NE doit PAS empêcher le marquage « traité » : sinon le
                # cycle suivant re-muterait le Ticket → doublon (2e réponse publique). On
                # journalise donc l'état atteint dans tous les cas (voir plus bas) et on
                # avale l'échec du Suivi en le loggant.
                try:
                    # Appliqué (semi/full-auto) → réponse PUBLIQUE au demandeur (brouillon seul).
                    # Suggestion → Suivi interne PRIVÉ annoté (brouillon jamais envoyé).
                    content = render_followup(outcome, refs, applied=applied)
                    if applied:
                        # DURCISSEMENT audit 2026-05 : avant toute publication PUBLIQUE, on
                        # RE-MASQUE le brouillon LLM (le LLM peut recracher une PII présente
                        # dans le ticket et non détectée à l'entrée, ou injectée) et on borne
                        # sa longueur. Le mode suggestion (privé) n'est pas concerné.
                        content = self._advanced(masking.mask(content, **self._mask_flags).text)
                        if len(content) > PUBLIC_DRAFT_MAX_CHARS:
                            content = content[:PUBLIC_DRAFT_MAX_CHARS].rstrip() + "…"
                    await self._itsm.write_followup(ticket.id, content, private=not applied)
                    wrote = True
                except Exception as exc:
                    logger.warning(
                        "triage: écriture du Suivi échouée (ticket=%s, applied=%s): %s",
                        ticket.id, applied, exc,
                    )

        # Journal TOUJOURS écrit (FR-19/20) — y compris si le Suivi a échoué après une
        # mutation : la trace d'audit doit refléter l'acte réellement appliqué à GLPI.
        with self._session_factory() as session:
            journal.record_decision(
                session, ticket.id, outcome, glpi_link=glpi_link, mode=mode.value,
                applied=applied, subject=ticket.title,
            )
        return wrote
