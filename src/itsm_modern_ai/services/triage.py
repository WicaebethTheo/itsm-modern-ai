"""Pipeline à deux étages + moteur à garde-fous (mode suggestion).

ORDRE IMMUABLE (project-context.md invariant 1) :
    [étage 1 : règles GLPI déjà appliquées ?] → cost cap (FR-10) → Masquage (FR-14)
    → appel LLM JSON mode + retry (FR-6/9/11) → validation Pydantic (frontière adaptateur)
    → validation Whitelist (FR-7) → seuil de confiance (FR-8) → dépôt Suivi / « à trier ».

« à trier » est la SEULE échappatoire (invariant 3). Mode suggestion : on n'écrit qu'un
Suivi interne privé, jamais un champ de Ticket (FR-17). Veto technicien implicite : rien
n'est appliqué sans action humaine, aucun rejet humain n'est enregistré (FR-18).

Un Ticket qui emprunte l'échappatoire APRÈS arbitrage (whitelist/seuil) reçoit un Suivi
PRIVÉ « non tranché » (`render_fallback_followup`) : aucune mutation, mais le Ticket cesse
d'être indistinguable d'un Ticket jamais examiné. L'échappatoire reste unique — c'est ce
qu'on FAIT des Tickets qui l'empruntent qui change, pas le nombre de branches du moteur.
"""

from __future__ import annotations

import html as _html
import logging
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field

import anyio
from sqlmodel import Session

from ..config.settings import Settings
from ..domain import engine, masking, prompting, whitelist
from ..domain.errors import LlmResponseError, LlmTransportError
from ..domain.models import (
    HandlerOutcome,
    Priority,
    Referentials,
    Ticket,
    TriageOutcome,
    TriageReason,
    estimate_tokens,
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

# Préfixe des lignes `llm_calls` correspondant à une tentative ÉCHOUÉE. On réutilise
# `response_received` plutôt que d'ajouter une colonne : pas de migration, l'export CSV
# DPO reste lisible tel quel, et surtout le COÛT atterrit dans la même colonne que celle
# lue par le plafond (FR-10) — c'est tout l'objet du correctif. Le préfixe est explicite
# et grep-able ; une ligne d'échec se reconnaît aussi à `completion_tokens = 0`.
LLM_FAILURE_PREFIX = "[ÉCHEC LLM]"

# Raisons pour lesquelles le triage N'A PAS EU LIEU : le Ticket ne doit pas être consommé.
# `ACCEPTED`, `LOW_CONFIDENCE` et les rejets de whitelist sont au contraire des ARBITRAGES
# rendus — le Ticket a été vu, la Décision est au Journal, il est légitimement traité.
RETRYABLE_REASONS = frozenset(
    {TriageReason.COST_CAP_REACHED, TriageReason.LLM_ERROR, TriageReason.INVALID_OUTPUT}
)


def is_arbitrated_rejection(outcome: TriageOutcome) -> bool:
    """Le garde-fou a REFUSÉ une Décision réellement rendue (vs « triage pas eu lieu »).

    Distinction structurante — les confondre crée un bug d'exploitation :

    - **Arbitrage rendu** (`low_confidence`, rejets de whitelist) : l'IA a répondu, le code
      a dit non. Le poller consomme le Ticket : il ne sera **jamais** rejoué. C'est le seul
      cas où l'on a quelque chose à annoncer au technicien dans GLPI.
    - **Triage pas eu lieu** (`RETRYABLE_REASONS` : panne LLM, sortie invalide, plafond) :
      le Ticket revient au cycle suivant. Y déposer un Suivi produirait une annotation par
      cycle sur une coupure réseau de trois secondes, puis un doublon au rejeu réussi.

    On dérive du complément de `RETRYABLE_REASONS` (plutôt que d'énumérer les motifs de
    refus) pour qu'un futur motif « pas eu lieu » ne soit pas oublié ici : il devra de toute
    façon être ajouté à `RETRYABLE_REASONS`, sans quoi le Ticket serait déjà brûlé à tort.
    """
    return (
        not outcome.accepted
        and outcome.decision is not None
        and outcome.reason not in RETRYABLE_REASONS
    )


@dataclass(slots=True)
class _LlmTrace:
    """Ce qu'on sait des appels LLM RÉELLEMENT ÉMIS, y compris quand ils ont échoué.

    Une tentative partie chez le fournisseur est FACTURÉE même si sa réponse est
    rejetée au parsing (les tokens ont été générés) ou si le transport casse après
    l'envoi. Sans cette trace, `handle()` n'avait rien à journaliser en cas d'échec.
    """

    prompt_sent: str = ""  # prompt masqué réellement envoyé (journalisable tel quel)
    failures: list[str] = field(default_factory=list)  # une entrée par tentative échouée


@dataclass(slots=True)
class _PersistResult:
    """Issue de la persistance d'un `TriageOutcome` (mutation + Suivi + Journal)."""

    wrote: bool = False  # un Suivi a été déposé
    db_error: bool = False  # une écriture en base a échoué (alimente le circuit-breaker)
    partial_mutation: bool = False  # GLPI muté à moitié → surtout ne pas rejouer


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


def _motif_a_trier(outcome: TriageOutcome, threshold: float) -> str:
    """Motif du refus, écrit pour un technicien — pas un code d'erreur à décoder."""
    d = outcome.decision
    assert d is not None
    match outcome.reason:
        case TriageReason.LOW_CONFIDENCE:
            return f"confiance insuffisante ({d.confidence:.0%}, seuil requis {threshold:.0%})"
        case TriageReason.CATEGORY_NOT_IN_WHITELIST:
            return (
                "l'IA n'a pas su choisir de catégorie"
                if d.category is None
                else "catégorie envisagée hors du périmètre autorisé"
            )
        case TriageReason.PRIORITY_NOT_IN_WHITELIST:
            return "priorité envisagée hors du périmètre autorisé"
        case TriageReason.TECHNICIAN_NOT_IN_WHITELIST:
            return "acteur envisagé hors du périmètre autorisé"
        case TriageReason.NO_ELIGIBLE_ASSIGNEE:
            return "aucun technicien ni groupe éligible ne correspond à ce ticket"
        case _:
            return outcome.reason.value


def render_fallback_followup(
    outcome: TriageOutcome,
    refs: Referentials,
    *,
    threshold: float,
    assigned: tuple[int | None, int | None] = (None, None),
) -> str:
    """Suivi PRIVÉ déposé sur un Ticket parti « à trier » après arbitrage (audit 2026-08).

    POURQUOI. Tout le traitement vivait sous `if outcome.accepted:` : un Ticket refusé par
    le garde-fou ne recevait dans GLPI **strictement rien** — ni champ, ni Suivi — et le
    poller le marquait « traité » (son motif n'est pas dans `RETRYABLE_REASONS`), donc il
    n'était jamais réexaminé. Il restait « Nouveau », indistinguable d'un Ticket que
    personne n'a ouvert, et la seule trace vivait dans notre Journal. Mesuré en lab :
    **7 Tickets sur 20**, sur une instance présentée comme « full-auto ».

    CE QU'IL DIT, ET CE QU'IL NE DIT PAS. On rend le **motif** du refus et ce que l'IA
    envisageait — pas une proposition à appliquer :

    - **aucun champ n'est écrit** (`ItsmPort.write_followup` ne touche pas le Ticket) ;
    - **pas de brouillon de réponse**, délibérément. Une confiance sous le seuil est basse
      sur l'ENSEMBLE de la Décision : afficher un brouillon qu'un technicien pressé
      copierait-collerait reviendrait à réintroduire par l'affichage la Décision que le
      garde-fou vient de refuser. Le mode `suggestion` (Décision ACCEPTÉE) reste le seul
      endroit où un brouillon est proposé ;
    - toute valeur hors du périmètre admin est **étiquetée comme telle**, pour qu'elle ne
      soit pas lue comme validée — et parce qu'elle renseigne l'admin sur ce qu'il faudrait
      peut-être rendre éligible.

    Effet de bord utile : le contenu ne reprend AUCUN texte libre du LLM ni du demandeur
    (que des identifiants et des libellés de référentiel) — donc ni PII à re-masquer, ni
    prompt-injection à échapper, contrairement au brouillon de `render_followup`.

    `assigned` = acteur RÉELLEMENT assigné par le repli, à ne pas confondre avec
    l'affectation *envisagée* par l'IA : c'est un aiguillage décidé par l'admin pour que le
    Ticket ait un propriétaire, pas une proposition du modèle.
    """
    d = outcome.decision
    assert d is not None

    if d.category is None:
        cat = "aucune (le modèle n'a pas tranché)"
    elif d.category in refs.categories:
        cat = f"{refs.categories[d.category]} (#{d.category})"
    else:
        cat = f"#{d.category} — hors du périmètre autorisé"

    try:
        prio = f"{Priority(d.priority).name} (#{d.priority})"
    except ValueError:
        prio = str(d.priority)
    if d.priority not in refs.priorities:
        prio += " — hors du périmètre autorisé"

    # Même filtre que la mutation réelle : on ne NOMME un acteur que s'il est éligible.
    tech_id, group_id = whitelist.effective_assignment(d, refs)
    if tech_id is not None:
        assignee = f"Technicien {refs.technicians[tech_id]} (#{tech_id})"
    elif group_id is not None:
        assignee = f"Groupe {refs.groups.get(group_id, str(group_id))} (#{group_id})"
    elif d.technician_id is not None:
        assignee = f"Technicien #{d.technician_id} — hors du périmètre autorisé"
    elif d.group_id is not None:
        assignee = f"Groupe #{d.group_id} — hors du périmètre autorisé"
    else:
        assignee = "aucun (le modèle n'a proposé ni technicien ni groupe)"

    fb_tech, fb_group = assigned
    if fb_tech is not None:
        repli = f"\n• Repli : assigné à {refs.technicians.get(fb_tech, f'#{fb_tech}')} (#{fb_tech})"
    elif fb_group is not None:
        repli = f"\n• Repli : assigné au groupe {refs.groups.get(fb_group, f'#{fb_group}')} (#{fb_group})"
    else:
        repli = ""

    cloture = (
        "Ce ticket n'a pas été catégorisé automatiquement : il attend un triage humain. "
        "Les valeurs ci-dessus sont indicatives — elles n'ont PAS passé le garde-fou et ne "
        "doivent pas être reprises telles quelles."
    )
    if repli:
        cloture += (
            "\nSeule l'affectation de repli a été appliquée (configurée par l'administrateur "
            "pour cette entité), afin que le ticket ne reste pas sans propriétaire."
        )
    return (
        "🤖 Triage NON TRANCHÉ — ITSM Modern AI (aucun champ de triage modifié)\n"
        f"• Motif : {_motif_a_trier(outcome, threshold)}\n"
        f"• Catégorie envisagée : {cat}\n"
        f"• Priorité envisagée : {prio}\n"
        f"• Affectation envisagée : {assignee}\n"
        f"• Confiance annoncée : {d.confidence:.0%}{repli}\n\n"
        f"{cloture}\n"
        "— Aucune suite donnée à ce ticket n'est enregistrée par le moteur."
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

    @property
    def _model_name(self) -> str:
        """Nom du modèle courant, pour journaliser un appel ÉCHOUÉ (pas de `LlmResult`)."""
        return getattr(self._llm, "model", "") or "inconnu"

    async def _call_llm(self, system: str, user: str, trace: _LlmTrace) -> LlmResult:
        """Appel LLM avec retry borné (FR-9) + backoff court.

        On retente aussi bien les erreurs de transport (réseau/429) que les réponses
        invalides (`LlmResponseError` : JSON malformé, schéma KO, `content: null` d'un
        filtre de contenu) — la docstring de `LlmResponseError` promet « après retry »,
        et une sortie non conforme est souvent transitoire (bavardage, troncature).

        Chaque tentative échouée est POUSSÉE dans `trace.failures` : elle est partie sur
        le réseau, donc potentiellement facturée, et devra apparaître dans `llm_calls`.
        """
        last: Exception | None = None
        for attempt in range(self._retries + 1):
            if attempt:  # jamais avant le 1er essai — uniquement entre deux tentatives
                await _sleep(LLM_RETRY_BACKOFF_S[min(attempt - 1, len(LLM_RETRY_BACKOFF_S) - 1)])
            try:
                return await self._llm.complete(system, user)
            except (LlmTransportError, LlmResponseError) as exc:
                last = exc
                trace.failures.append(f"{type(exc).__name__}: {exc}")
        raise last  # type: ignore[misc]

    async def _evaluate(
        self, ticket_id: int, raw_text: str, refs: Referentials
    ) -> tuple[TriageOutcome, LlmResult | None, _LlmTrace]:
        """Masquage → LLM → Pydantic → Whitelist → seuil. N'écrit RIEN (sandbox-safe).

        Renvoie en plus la trace des tentatives : `handle()` en a besoin pour comptabiliser
        les appels facturés même quand aucune `LlmResult` n'est revenue.
        """
        masked = masking.mask(raw_text, **self._mask_flags)
        system = self._system_prompt
        user = prompting.build_user_prompt(
            self._advanced(masked.text), refs, self._profiles, self._guidance
        )
        # Ce qui part au fournisseur EST déjà masqué : on le journalise tel quel plutôt
        # que de re-masquer le texte brut une seconde fois (et de risquer un écart).
        trace = _LlmTrace(prompt_sent=self._advanced(masked.text))
        try:
            result = await self._call_llm(system, user, trace)
        except LlmResponseError as exc:
            # Sortie LLM invalide après garde-fous (JSON malformé, schéma KO). Tracé pour
            # diagnostiquer côté admin sans exposer le détail au client.
            logger.warning("triage: réponse LLM invalide (ticket=%s): %s", ticket_id, exc)
            return TriageOutcome(accepted=False, reason=TriageReason.INVALID_OUTPUT), None, trace
        except LlmTransportError as exc:
            # Réseau/clé/quota : visible dans les logs pour qualifier la panne — la sandbox
            # ne remontait qu'un `reason=llm_error` opaque sans la cause exacte.
            logger.warning("triage: appel LLM échoué (ticket=%s): %s", ticket_id, exc)
            return TriageOutcome(accepted=False, reason=TriageReason.LLM_ERROR), None, trace

        outcome = engine.evaluate(result.decision, refs, self._confidence_threshold)
        return outcome, result, trace

    async def evaluate_text(
        self, ticket_id: int, raw_text: str, refs: Referentials
    ) -> tuple[TriageOutcome, LlmResult | None]:
        """Façade historique (sandbox) : évaluation sans trace de facturation."""
        outcome, result, _ = await self._evaluate(ticket_id, raw_text, refs)
        return outcome, result

    async def handle(self, ticket: Ticket, refs: Referentials) -> HandlerOutcome:
        """Handler du poller. Voir `HandlerOutcome` pour le contrat rendu.

        Orchestration à ordre immuable (cf. docstring du module) ; chaque étape est
        déléguée à une méthode dédiée pour la lisibilité, sans changer l'enchaînement.
        """
        # Étage 1 (FR-5) : déjà traité par une règle GLPI → pas d'appel LLM.
        if rules_fully_handled(ticket):
            logger.info("ticket %s déjà traité par règle GLPI → skip moteur", ticket.id)
            return HandlerOutcome()

        # Cost cap (FR-10) AVANT tout appel facturant.
        capped, cap_db_error = self._cost_cap_reached(ticket)
        if capped:
            # Le triage N'A PAS EU LIEU : aucun appel n'a été émis, aucune Décision rendue.
            # Le Ticket doit rester repris au cycle suivant — et il ne consomme AUCUN essai
            # (`costly=False`) : un plafond atteint ne coûte rien, il n'y a donc pas de
            # boucle facturée à borner, seulement un arriéré à rejouer une fois la fenêtre
            # de 24 h passée (ou le plafond relevé depuis la console).
            return HandlerOutcome(
                retryable=True, db_error=cap_db_error, reason=TriageReason.COST_CAP_REACHED
            )

        raw_text = f"{ticket.title}\n{ticket.content}".strip()
        outcome, result, trace = await self._evaluate(ticket.id, raw_text, refs)

        journal_db_error = self._journal_llm_calls(ticket, trace, result)
        persisted = await self._persist_outcome(ticket, outcome, refs)

        # Une mutation partielle (GLPI V2) interdit le rejeu, quelle que soit la raison :
        # le Ticket a DÉJÀ bougé, le rejouer le muterait deux fois et le re-facturerait.
        retryable = outcome.reason in RETRYABLE_REASONS and not persisted.partial_mutation
        return HandlerOutcome(
            followup_written=persisted.wrote,
            retryable=retryable,
            costly=True,  # au moins une tentative est partie chez le fournisseur
            db_error=journal_db_error or persisted.db_error,
            reason=outcome.reason,
        )

    def _cost_cap_reached(self, ticket: Ticket) -> tuple[bool, bool]:
        """Cost cap (FR-10) : (atteint ?, échec d'écriture ?). Journalise « à trier »."""
        try:
            with self._session_factory() as session:
                if not cost_cap.is_over_cap(session, self._cost_cap_eur_per_day):
                    return False, False
                journal.record_decision(
                    session, ticket.id,
                    TriageOutcome(accepted=False, reason=TriageReason.COST_CAP_REACHED),
                    subject=ticket.title,
                )
            logger.warning("cost cap atteint → ticket %s en « à trier »", ticket.id)
            return True, False
        except Exception as exc:
            # Base indisponible (disque plein, volume en lecture seule) : on NE PEUT PAS
            # savoir si le plafond est atteint. Défaut sûr = considérer qu'il l'est, donc
            # ne lancer AUCUN appel facturant — c'est précisément le scénario où le cap
            # devenait aveugle (les insertions `llm_calls` échouent aussi) et où le moteur
            # rejouait 5 appels par cycle, indéfiniment. Le poller prend le relais avec
            # son circuit-breaker via `db_error`.
            logger.error(
                "triage: plafond de coût non vérifiable (base en échec, ticket=%s): %s "
                "→ aucun appel LLM lancé (défaut sûr)", ticket.id, exc,
            )
            return True, True

    def _journal_llm_calls(
        self, ticket: Ticket, trace: _LlmTrace, result: LlmResult | None
    ) -> bool:
        """Journalise TOUTES les tentatives LLM émises (FR-19). True si l'écriture a échoué.

        POURQUOI les échecs aussi : `_journal_llm_call` ne s'exécutait que si une
        `LlmResult` était revenue. Or une tentative rejetée au parsing (`LlmResponseError`)
        ou cassée en transport a bel et bien consommé des tokens chez le fournisseur.
        Résultat mesuré : 50 tickets, 150 appels réels, **0 ligne en base**, `is_over_cap`
        systématiquement False — le plafond (FR-10) ne pouvait jamais se déclencher.

        Une ligne par TENTATIVE (et non par ticket) : c'est le nombre d'appels réellement
        facturés, et `count_llm_calls` cesse de mentir. Coût d'un échec : tokens du prompt
        ESTIMÉS (on connaît exactement le texte envoyé) et complétion à 0 — la sortie
        rejetée n'est pas récupérable, on préfère sous-estimer que d'inventer un volume.
        """
        price_in = self._settings.llm_price_input_per_mtok
        price_out = self._settings.llm_price_output_per_mtok
        total = len(trace.failures) + (1 if result is not None else 0)
        prompt_tokens_est = estimate_tokens(trace.prompt_sent)
        try:
            with self._session_factory() as session:
                for i, failure in enumerate(trace.failures, start=1):
                    journal.record_llm_call(
                        session,
                        ticket_id=ticket.id,
                        model=self._model_name,
                        prompt_sent=trace.prompt_sent,
                        response_received=f"{LLM_FAILURE_PREFIX} tentative {i}/{total} — {failure}",
                        prompt_tokens=prompt_tokens_est,
                        completion_tokens=0,
                        cost_eur=cost_cap.cost_eur(prompt_tokens_est, 0, price_in, price_out),
                    )
                if result is not None:
                    journal.record_llm_call(
                        session,
                        ticket_id=ticket.id,
                        model=result.model,
                        prompt_sent=trace.prompt_sent,
                        response_received=result.raw_response,
                        prompt_tokens=result.prompt_tokens,
                        completion_tokens=result.completion_tokens,
                        cost_eur=cost_cap.cost_eur(
                            result.prompt_tokens, result.completion_tokens, price_in, price_out
                        ),
                    )
            return False
        except Exception as exc:
            # Ne pas laisser remonter : sinon le Ticket n'est jamais marqué et l'appel est
            # re-facturé à chaque cycle. On signale l'échec au poller (circuit-breaker).
            logger.error(
                "triage: journalisation des appels LLM échouée (ticket=%s): %s", ticket.id, exc
            )
            return True

    async def _persist_outcome(
        self, ticket: Ticket, outcome: TriageOutcome, refs: Referentials
    ) -> _PersistResult:
        """Applique la Décision selon le mode du périmètre, puis journalise (FR-17).

        Mode du périmètre (par entité, défaut global) → `resolve_action` :
        - suggestion → Suivi privé seul (aucune mutation) ;
        - semi/full-auto → mutation GLPI (`apply_decision`) PUIS Suivi privé (audit).
        Le garde-fou (whitelist + seuil) a déjà tranché en amont ; ici on ne fait
        QUE dispatcher l'action d'une Décision acceptée.

        « à trier » ne pose toujours AUCUN champ de triage, mais ne passe plus sous
        silence : un refus ARBITRÉ (cf. `is_arbitrated_rejection`) dépose un Suivi PRIVÉ
        « non tranché » et, hors mode `suggestion`, assigne la cible de repli de l'entité.
        """
        glpi_link = _web_link(self._glpi_base_url, ticket.id)
        mode = self._default_mode
        applied = False
        wrote = False
        fallback_applied = False  # un acteur de repli a été assigné sur un REFUS
        partial_error = ""  # message d'une mutation GLPI partielle (annotation Journal)

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
                # CORRECTION du commentaire d'origine, qui était FAUX : « si apply échoue,
                # rien n'a été muté » ne vaut que pour le connecteur legacy (un seul PATCH).
                # L'API GLPI V2 fait DEUX appels réseau (PATCH des champs, puis POST
                # TeamMember) : un échec du second laisse le Ticket muté dans GLPI. On ne
                # peut pas rendre GLPI transactionnel, alors on rend l'état OBSERVABLE
                # (annotation au Journal) et NON-BOUCLANT (le Ticket est consommé) — sinon
                # il serait re-muté ET re-facturé à chaque cycle, sans une seule trace.
                # Un échec « propre » (rien n'a bougé) remonte, lui, tel quel : le Ticket
                # reste rejouable, sous la protection du compteur d'essais du poller.
                try:
                    await self._itsm.apply_decision(
                        ticket.id,
                        category=d.category,
                        priority=d.priority,
                        technician_id=tech_id,
                        group_id=group_id,
                    )
                    applied = True
                except Exception as exc:
                    if not getattr(exc, "partial_mutation", False):
                        raise
                    partial_error = f"{type(exc).__name__}: {exc}"
                    applied = True  # GLPI A bougé : le Journal doit le dire (audit)
                    logger.error(
                        "triage: mutation GLPI PARTIELLE sur le ticket %s — état incohérent "
                        "journalisé, ticket NON rejoué: %s", ticket.id, exc,
                    )
            if action.write_followup and not partial_error:  # Décision acceptée, état sain
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

        elif is_arbitrated_rejection(outcome) and self._itsm is not None:
            # Mode de l'entité : il commande le repli ASSIGNÉ. En `suggestion`, l'instance
            # promet zéro mutation — or assigner EST une mutation. Le Suivi « non tranché »,
            # lui, reste déposé dans les trois modes (il n'applique rien).
            with self._session_factory() as session:
                mode, _ = referentials.mode_for_entity(
                    session,
                    ticket.entity_id,
                    default_mode=self._default_mode,
                    default_auto_min_confidence=self._auto_min_confidence,
                )
                fb_tech, fb_group = (
                    referentials.fallback_for_entity(session, ticket.entity_id, refs)
                    if mode is not ExecutionMode.SUGGESTION
                    else (None, None)
                )
            if fb_tech is not None or fb_group is not None:
                try:
                    # ROUTER, JAMAIS CLASSER : `assign_actor` ne touche ni la catégorie ni
                    # la priorité. Une confiance sous le seuil est basse sur l'ENSEMBLE de
                    # la Décision — une mauvaise catégorie est pire qu'aucune, elle serait
                    # crue par les stats, les règles GLPI et le technicien.
                    await self._itsm.assign_actor(
                        ticket.id, technician_id=fb_tech, group_id=fb_group
                    )
                    fallback_applied = True
                except Exception as exc:
                    # Un repli raté ne doit pas dégrader l'existant : on retombe sur le
                    # comportement « Suivi seul », qui reste meilleur que rien.
                    fb_tech = fb_group = None
                    logger.warning(
                        "triage: repli non assigné (ticket=%s): %s", ticket.id, exc
                    )
            # « à trier » ARBITRÉ : le garde-fou a refusé, et le poller ne rejouera JAMAIS
            # ce Ticket. Sans ce Suivi, GLPI ne reçoit RIEN et le Ticket devient invisible
            # (cf. `render_fallback_followup`). Il INFORME, il n'applique pas :
            # `write_followup` ne touche aucun champ, et le contenu ne porte ni brouillon
            # ni texte libre du LLM. Il vaut donc dans les TROIS modes — y compris
            # `suggestion`, qui promet zéro mutation et où le trou existait aussi.
            try:
                await self._itsm.write_followup(
                    ticket.id,
                    render_fallback_followup(
                        outcome,
                        refs,
                        threshold=self._confidence_threshold,
                        assigned=(fb_tech, fb_group),
                    ),
                    private=True,
                )
                wrote = True
            except Exception as exc:
                # Acte SECONDAIRE, comme le Suivi d'une Décision acceptée : son échec ne
                # doit ni remonter (le Ticket ne serait jamais marqué → appel LLM re-facturé
                # à chaque cycle) ni empêcher la journalisation de la Décision juste après.
                logger.warning(
                    "triage: Suivi « à trier » non déposé (ticket=%s, motif=%s): %s",
                    ticket.id, outcome.reason.value, exc,
                )

        # Journal TOUJOURS écrit (FR-19/20) — y compris si le Suivi a échoué après une
        # mutation : la trace d'audit doit refléter l'acte réellement appliqué à GLPI.
        # L'écriture est PROTÉGÉE au même titre que le Suivi juste au-dessus : une panne
        # de base ici faisait remonter l'exception, le Ticket n'était jamais marqué et le
        # cycle suivant produisait une suggestion DUPLIQUÉE + un appel LLM re-facturé.
        # On avale donc l'échec, on le trace en ERROR et on le signale au poller (`db_error`),
        # dont le circuit-breaker coupera le cycle si la base reste en échec.
        db_error = False
        try:
            with self._session_factory() as session:
                decision_id = journal.record_decision(
                    session, ticket.id, outcome, glpi_link=glpi_link, mode=mode.value,
                    applied=applied, subject=ticket.title, fallback_applied=fallback_applied,
                )
                if partial_error:
                    # Seule trace lisible par l'admin de l'état réellement atteint dans
                    # GLPI : catégorie/priorité posées, acteur NON assigné, aucun Suivi.
                    journal.set_annotation(
                        session, decision_id,
                        "⚠️ Mutation GLPI PARTIELLE : champs appliqués, assignation de "
                        f"l'acteur échouée — à terminer manuellement. Détail : {partial_error}",
                    )
        except Exception as exc:
            db_error = True
            logger.error(
                "triage: journalisation de la Décision échouée (ticket=%s, applied=%s): %s "
                "— la Décision est perdue pour l'audit, le Ticket reste marqué pour éviter "
                "un doublon de suggestion.", ticket.id, applied, exc,
            )
        return _PersistResult(wrote=wrote, db_error=db_error, partial_mutation=bool(partial_error))
