"""Boucle de polling idempotente (FR-2) + rafraîchissement Whitelist (FR-3).

Garanties (NFR3) : aucun Ticket neuf perdu si GLPI est indisponible (reprise au
cycle suivant) ; aucun retraitement (idempotence `processed_tickets`) ; aucun crash
bloquant la file (les erreurs d'un Ticket n'arrêtent pas les autres).

Le `handler` est le seam de l'Epic 3 (masquage → LLM → whitelist → Suivi). En Epic 2,
il est absent : le poller établit seulement la plomberie « le Ticket entre ».
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache

from sqlmodel import Session

from ..config.settings import Settings, get_settings
from ..domain import masking
from ..domain.errors import ItsmError
from ..domain.models import HandlerOutcome, Referentials, Ticket
from ..persistence import db, idempotency
from ..ports.itsm import ItsmPort
from ..services.runtime_config import RuntimeConfigService
from ..services.whitelist_cache import WhitelistCache

logger = logging.getLogger("itsm.poller")

# Le handler renvoie un `HandlerOutcome` (contrat élargi). Le `bool` historique reste
# accepté : c'est la forme qu'utilisent les handlers de test/plomberie (« Suivi écrit ? »).
TicketHandler = Callable[[Ticket, Referentials], Awaitable["HandlerOutcome | bool"]]
SessionFactory = Callable[[], AbstractContextManager[Session]]

# ── Anti-boucle facturée ──────────────────────────────────────────────────────
# Un Ticket dont le triage n'a PAS eu lieu (panne LLM, sortie invalide) n'est plus
# consommé : il repasse au cycle suivant. Sans borne, un Ticket systématiquement
# invalide (contenu pathologique que le modèle ne sait pas trier) serait re-facturé
# éternellement. On borne donc les tentatives COÛTEUSES.
#
# ARBITRAGE — 5 essais :
# * à l'intervalle livré (60 s), cela couvre ~5 min de panne fournisseur, l'ordre de
#   grandeur d'un incident transitoire (429, bascule de nœud, redémarrage de passerelle) ;
# * le sur-coût maximal d'un Ticket irrécupérable est borné à 5 tentatives, pas à l'infini ;
# * ce n'est que la SECONDE ceinture : le plafond de coût (FR-10), redevenu effectif
#   maintenant que les appels échoués sont journalisés, coupe l'hémorragie globale bien
#   avant, et un plafond atteint ne consomme lui aucun essai (il ne coûte rien).
# Le compteur est volontairement EN MÉMOIRE (le poller est reconstruit à chaque cycle par
# `api/app.py`, d'où l'état au niveau module) : ce n'est pas une donnée d'audit, et un
# redémarrage — typiquement APRÈS correction de la panne — doit rendre leur chance aux
# Tickets en attente. Le Journal, lui, garde une ligne « à trier » par tentative.
MAX_TRIAGE_ATTEMPTS = 5
_ATTEMPTS_MAX_ENTRIES = 10_000  # borne mémoire (arriéré GLPI massif) — éviction FIFO
_attempts: dict[int, int] = {}

# ── Circuit-breaker d'écriture en base ────────────────────────────────────────
# Si la base ne peut plus être écrite (disque plein, volume monté en lecture seule),
# `mark_processed` échoue → le Ticket n'est jamais marqué → il est repayé à CHAQUE
# cycle ; et comme les insertions `llm_calls` échouent aussi, le plafond de coût ne se
# déclenche jamais. Mesuré : 5 appels LLM par cycle, indéfiniment. Au-delà de N échecs
# d'écriture CONSÉCUTIFS, on interrompt le cycle avec un log ERROR explicite : mieux vaut
# un moteur à l'arrêt et bruyant qu'un moteur qui facture dans le vide en silence.
MAX_CONSECUTIVE_DB_FAILURES = 3

_ERROR_MESSAGE_MAX_CHARS = 300  # même borne que `_detail_sur` (routes/debug.py)


@dataclass
class PollStats:
    fetched: int = 0
    processed_new: int = 0
    skipped_already_done: int = 0
    skipped_out_of_scope: int = 0  # entité hors périmètre sélectionné (Story 5.4)
    errors: int = 0
    # Raison lisible du dernier incident du cycle (périmètre vide, GLPI injoignable,
    # base en échec…). C'est LA réponse à « pourquoi aucun ticket n'est trié ? ».
    error_message: str = ""


def _short_reason(text: str) -> str:
    """Message de diagnostic masqué (PII) et borné — jamais un canal de fuite.

    Un message d'erreur peut embarquer un extrait de réponse GLPI/fournisseur. On le
    fait passer par le masquage du produit avec `network=False` : sur un déploiement
    on-premise, l'IP/l'hôte EST le diagnostic (mauvais VLAN, port fermé) ; masquer un
    secret, oui — masquer l'information recherchée, non.
    """
    clean = masking.mask(text, network=False).text
    if len(clean) <= _ERROR_MESSAGE_MAX_CHARS:
        return clean
    return clean[:_ERROR_MESSAGE_MAX_CHARS].rstrip() + "…"


def _bump_attempt(ticket_id: int) -> int:
    """Incrémente et renvoie le nombre de tentatives coûteuses pour ce Ticket."""
    count = _attempts.get(ticket_id, 0) + 1
    _attempts[ticket_id] = count
    while len(_attempts) > _ATTEMPTS_MAX_ENTRIES:  # éviction FIFO (dict ordonné)
        del _attempts[next(iter(_attempts))]
    return count


def _attempts_count(ticket_id: int) -> int:
    """Nombre de tentatives déjà comptées, SANS incrémenter (lecture seule)."""
    return _attempts.get(ticket_id, 0)


def _clear_attempt(ticket_id: int) -> None:
    """Le Ticket a été arbitré (ou consommé) : son compteur n'a plus de raison d'être."""
    _attempts.pop(ticket_id, None)


def reset_attempts() -> None:
    """Vide le compteur d'essais (isolation des tests)."""
    _attempts.clear()


def _as_outcome(value: HandlerOutcome | bool | None) -> HandlerOutcome:
    """Normalise le retour du handler — le `bool` historique reste accepté."""
    if isinstance(value, HandlerOutcome):
        return value
    return HandlerOutcome(followup_written=bool(value))


@contextmanager
def _default_session() -> Iterator[Session]:
    with db.session_scope() as s:
        yield s


class _NoSecrets:
    """`SecretsPort` inerte pour l'écriture des seules clés NON secrètes du poller.

    Le poller n'écrit que des clés de `PLAIN_KEYS` (`poll_last_*`) : `set()` ne
    déréférence jamais la boîte à secrets. Plutôt que de faire remonter jusqu'au
    scheduler la boîte à secrets de l'application, on passe ce stub qui LÈVE si un
    secret était écrit un jour par erreur — fail-fast plutôt que chiffrement fantôme.
    """

    def encrypt(self, plaintext: str) -> str:  # pragma: no cover - garde-fou
        raise RuntimeError("le poller n'écrit aucun secret")

    def decrypt(self, token: str) -> str:  # pragma: no cover - garde-fou
        raise RuntimeError("le poller ne lit aucun secret")


@lru_cache(maxsize=1)
def _ambient_settings() -> Settings:
    """`Settings` de repli, construit UNE fois (relire le .env à chaque cycle serait absurde).

    Il ne sert qu'aux valeurs par défaut d'environnement de `RuntimeConfigService`, et les
    clés écrites ici (`poll_last_*`) n'en ont aucune : le choix de l'instance est donc sans
    incidence fonctionnelle sur l'état persisté.
    """
    return get_settings()


def _plain_runtime_config(session: Session) -> RuntimeConfigService:
    """`RuntimeConfigService` en écriture de réglages NON secrets uniquement."""
    return RuntimeConfigService(session, _NoSecrets(), _ambient_settings())


class TriagePoller:
    def __init__(
        self,
        itsm: ItsmPort,
        whitelist_cache: WhitelistCache,
        *,
        handler: TicketHandler | None = None,
        session_factory: SessionFactory = _default_session,
        referentials_loader: Callable[[], Referentials] | None = None,
        config_factory: Callable[[Session], RuntimeConfigService] = _plain_runtime_config,
    ) -> None:
        self._itsm = itsm
        self._cache = whitelist_cache
        self._handler = handler
        self._session_factory = session_factory
        # En prod : périmètre EFFECTIF (sélections admin en base). Défaut (tests) : GLPI.
        self._referentials_loader = referentials_loader
        self._config_factory = config_factory

    async def _load_referentials(self) -> Referentials:
        if self._referentials_loader is not None:
            return self._referentials_loader()
        return await self._itsm.get_referentials()

    async def poll_once(self) -> PollStats:
        """Un cycle complet. L'état final est TOUJOURS persisté (observabilité)."""
        stats = PollStats()
        try:
            await self._run_cycle(stats)
        except Exception as exc:  # filet : un plantage ne doit pas rester invisible
            stats.errors += 1
            stats.error_message = _short_reason(f"{type(exc).__name__}: {exc}")
            raise
        finally:
            self._persist_stats(stats)
        return stats

    async def _run_cycle(self, stats: PollStats) -> None:
        # 1) Charger la Whitelist effective (FR-3/FR-7). Échec → cycle sauté proprement.
        try:
            self._cache.refresh(await self._load_referentials())
        except ItsmError as exc:
            logger.warning("poll: référentiels indisponibles, cycle sauté: %s", exc)
            stats.error_message = _short_reason(f"Référentiels GLPI indisponibles: {exc}")
            return

        # 1bis) Périmètre vide (aucune catégorie sélectionnée par l'admin) : TOUTE décision
        # serait rejetée par la whitelist. On saute le cycle SANS marquer les tickets traités
        # — sinon chaque ticket déclencherait un appel LLM payant au rejet garanti puis serait
        # consommé pour toujours, et l'arriéré serait perdu une fois le périmètre configuré.
        if not self._cache.referentials.categories:
            logger.info(
                "poll: aucune catégorie dans le périmètre effectif → cycle sauté "
                "(aucun ticket consommé). Sélectionnez des catégories dans la console."
            )
            stats.error_message = (
                "Aucune catégorie dans le périmètre effectif → cycle sauté "
                "(aucun ticket consommé). Sélectionnez des catégories dans la console."
            )
            return

        # 2) Lire les Tickets « New » (FR-2). Indispo → reprise au cycle suivant.
        try:
            tickets = await self._itsm.get_new_tickets()
        except ItsmError as exc:
            logger.warning("poll: lecture des tickets impossible, cycle sauté: %s", exc)
            stats.error_message = _short_reason(f"Lecture des tickets GLPI impossible: {exc}")
            return

        # Traitements INTERROMPUS au cycle précédent (arrêt brutal après une écriture GLPI).
        # Ces Tickets ne seront PAS rejoués — une seconde réponse publique au demandeur est
        # bien pire qu'un Ticket laissé au triage humain. Mais le silence serait pire encore :
        # on le dit en ERROR, avec les identifiants, pour que l'admin puisse vérifier GLPI.
        try:
            with self._session_factory() as session:
                orphelins = idempotency.interrupted(session)
            if orphelins:
                logger.error(
                    "poll: %d Ticket(s) au traitement INTERROMPU (arrêt brutal après une "
                    "écriture GLPI ?) : %s — ils ne seront pas rejoués (aucun doublon de "
                    "réponse). Vérifier leur état dans GLPI.",
                    len(orphelins), ", ".join(str(t) for t in sorted(orphelins)[:20]),
                )
        except Exception:  # observabilité seulement : ne doit jamais empêcher un cycle
            logger.exception("poll: lecture des traitements interrompus impossible")

        stats.fetched = len(tickets)
        scope_entities = self._cache.referentials.entities  # vide = toutes (défaut sûr)
        db_failures = 0  # échecs d'écriture CONSÉCUTIFS (circuit-breaker)
        for ticket in tickets:
            try:
                # Filtrage par périmètre d'entité (Story 5.4) : on ne marque PAS « traité »
                # pour qu'un Ticket soit repris si l'admin élargit le périmètre ensuite.
                if scope_entities and ticket.entity_id not in scope_entities:
                    stats.skipped_out_of_scope += 1
                    continue

                with self._session_factory() as session:
                    if idempotency.is_processed(session, ticket.id):
                        stats.skipped_already_done += 1
                        continue

                # RÉSERVATION avant toute écriture GLPI (fenêtre de doublon, cf.
                # `ProcessedTicket`). Un arrêt brutal après l'écriture laisse désormais une
                # trace locale : le Ticket ne sera pas rejoué, donc pas de seconde réponse
                # publique au demandeur. Un échec de réservation NE DOIT PAS faire agir :
                # on préfère reporter le Ticket plutôt que d'écrire dans GLPI à l'aveugle.
                try:
                    with self._session_factory() as session:
                        idempotency.claim(session, ticket.id)
                except Exception as exc:
                    db_failures += 1
                    stats.errors += 1
                    logger.exception(
                        "poll: réservation impossible pour le Ticket %s — aucun traitement "
                        "lancé (le Ticket reste en file): %s", ticket.id, exc,
                    )
                    if db_failures >= MAX_CONSECUTIVE_DB_FAILURES:
                        self._trip_breaker(stats, db_failures)
                        return
                    continue

                outcome = HandlerOutcome()
                if self._handler is not None:
                    outcome = _as_outcome(await self._handler(ticket, self._cache.referentials))

                if not self._consume_ticket(ticket, outcome):
                    # Triage non abouti et essais restants : on laisse le Ticket en file — il
                    # faut donc RENDRE la réservation, sinon une panne LLM de trois secondes
                    # brûlerait le Ticket définitivement (régression pire que le défaut visé).
                    try:
                        with self._session_factory() as session:
                            idempotency.release(session, ticket.id)
                    except Exception:
                        logger.exception(
                            "poll: réservation non rendue pour le Ticket %s — il ne sera pas "
                            "rejoué tant qu'elle subsiste", ticket.id,
                        )
                    if outcome.db_error:
                        db_failures += 1
                        if db_failures >= MAX_CONSECUTIVE_DB_FAILURES:
                            self._trip_breaker(stats, db_failures)
                            return
                    continue

                try:
                    with self._session_factory() as session:
                        idempotency.mark_processed(
                            session, ticket.id, followup_written=outcome.followup_written
                        )
                except Exception as exc:
                    # Écriture « traité » impossible : le Ticket sera revu (et repayé) au
                    # cycle suivant. C'est le scénario disque plein → on compte et on coupe.
                    db_failures += 1
                    stats.errors += 1
                    logger.exception(
                        "poll: marquage « traité » impossible pour le Ticket %s: %s",
                        ticket.id, exc,
                    )
                    if db_failures >= MAX_CONSECUTIVE_DB_FAILURES:
                        self._trip_breaker(stats, db_failures)
                        return
                    continue

                _clear_attempt(ticket.id)
                db_failures = 0 if not outcome.db_error else db_failures + 1
                if db_failures >= MAX_CONSECUTIVE_DB_FAILURES:
                    self._trip_breaker(stats, db_failures)
                    return
                stats.processed_new += 1
            except Exception as exc:  # un Ticket en erreur ne bloque pas les autres
                stats.errors += 1
                stats.error_message = _short_reason(
                    f"Ticket {ticket.id} — {type(exc).__name__}: {exc}"
                )
                logger.exception("poll: erreur sur le Ticket %s: %s", ticket.id, exc)
                # Une exception non gérée survenant APRÈS l'appel LLM (mutation GLPI qui
                # échoue en boucle, bug d'adaptateur) est elle aussi RE-FACTURÉE à chaque
                # cycle : elle consomme donc un essai, exactement comme un triage non
                # abouti. Sans ça, le Ticket resterait éternellement dans la file.
                # RÉSERVATION : on la REND tant qu'il reste des essais, pour ne pas
                # dégrader le rejeu borné existant. La distinction est délibérée —
                #   * exception ATTRAPÉE ici = le processus est VIVANT, le comportement
                #     historique (rejeu borné) reste le bon compromis ;
                #   * arrêt BRUTAL (OOM, reboot, kill) = aucun code ne s'exécute, la
                #     réservation survit en base et fait son office. C'est CETTE fenêtre-là
                #     que le marquage en deux temps referme.
                # Une fois les essais épuisés, la réservation est au contraire CONSERVÉE :
                # le Ticket est abandonné, et son état GLPI reste incertain.
                if self._handler is not None and _bump_attempt(ticket.id) < MAX_TRIAGE_ATTEMPTS:
                    try:
                        with self._session_factory() as session:
                            idempotency.release(session, ticket.id)
                    except Exception:
                        logger.exception(
                            "poll: réservation non rendue pour le Ticket %s", ticket.id
                        )
                if self._handler is not None and _attempts_count(ticket.id) >= MAX_TRIAGE_ATTEMPTS:
                    logger.error(
                        "poll: ticket %s abandonné après %d erreurs de traitement → marqué "
                        "« traité » pour ne plus être re-facturé.",
                        ticket.id, MAX_TRIAGE_ATTEMPTS,
                    )
                    _clear_attempt(ticket.id)
                    try:
                        with self._session_factory() as session:
                            idempotency.mark_processed(session, ticket.id, followup_written=False)
                    except Exception:
                        logger.exception(
                            "poll: abandon du ticket %s non persistable (base en échec)", ticket.id
                        )

        logger.info(
            "poll terminé: fetched=%d new=%d skip=%d hors_périmètre=%d err=%d",
            stats.fetched,
            stats.processed_new,
            stats.skipped_already_done,
            stats.skipped_out_of_scope,
            stats.errors,
        )

    def _consume_ticket(self, ticket: Ticket, outcome: HandlerOutcome) -> bool:
        """Le Ticket doit-il être marqué « traité » ? False = on le laisse en file.

        `mark_processed` était appelé QUEL QUE SOIT le résultat du handler : un plafond
        atteint ou une panne LLM de 10 min brûlait DÉFINITIVEMENT tous les Tickets de la
        fenêtre, sans reprise ni écran pour les rejouer. Même raisonnement que le cas
        « périmètre vide » plus haut : ce qui n'a pas été arbitré ne doit pas être consommé.
        Le compteur d'essais est le garde-fou qui empêche ce report de devenir éternel.
        """
        if not outcome.retryable:
            return True
        if not outcome.costly:
            # Report GRATUIT (plafond de coût atteint) : aucune tentative n'est partie chez
            # le fournisseur, donc aucune boucle facturée à borner. Le Ticket attend que la
            # fenêtre de 24 h glisse ou que l'admin relève le plafond.
            logger.info(
                "poll: ticket %s reporté sans consommer d'essai (%s)",
                ticket.id, outcome.reason.value if outcome.reason else "?",
            )
            return False
        attempts = _bump_attempt(ticket.id)
        if attempts < MAX_TRIAGE_ATTEMPTS:
            logger.warning(
                "poll: triage non abouti sur le ticket %s (%s) → conservé pour rejeu "
                "(tentative %d/%d)",
                ticket.id, outcome.reason.value if outcome.reason else "?",
                attempts, MAX_TRIAGE_ATTEMPTS,
            )
            return False
        logger.error(
            "poll: ticket %s abandonné après %d tentatives infructueuses (%s) → marqué "
            "« traité » pour ne plus être re-facturé. Le Journal en garde une ligne « à "
            "trier » par tentative ; à reprendre manuellement.",
            ticket.id, attempts, outcome.reason.value if outcome.reason else "?",
        )
        _clear_attempt(ticket.id)
        return True

    def _trip_breaker(self, stats: PollStats, failures: int) -> None:
        """Coupe le cycle après N échecs d'écriture consécutifs (base indisponible)."""
        stats.errors += 1
        stats.error_message = (
            f"{failures} échecs d'écriture en base consécutifs → cycle interrompu. "
            "Vérifiez l'espace disque et les droits du volume ./data."
        )
        logger.error(
            "poll: %d échecs d'écriture en base CONSÉCUTIFS → cycle INTERROMPU. Sans cette "
            "coupure, les tickets non marqués seraient re-triés (et re-facturés) à chaque "
            "cycle, et le plafond de coût resterait aveugle (ses insertions échouent aussi). "
            "Vérifiez l'espace disque et les droits du volume ./data.",
            failures,
        )

    def _persist_stats(self, stats: PollStats) -> None:
        """Persiste l'état du DERNIER cycle (clés déjà déclarées dans `PLAIN_KEYS`).

        POURQUOI : `PollStats` n'existait que le temps d'un `logger.info` puis était jeté.
        C'est pourtant l'unique réponse à « pourquoi aucun ticket n'est trié ? » (périmètre
        vide ? GLPI injoignable ? tout déjà traité ?), et elle n'était lisible qu'en
        ouvrant `docker logs`. Exposé ensuite par `GET /api/status` (bloc `last_poll`).
        Best-effort : l'observabilité ne doit jamais faire tomber le cycle qu'elle observe.
        """
        try:
            with self._session_factory() as session:
                cfg = self._config_factory(session)
                cfg.set("poll_last_run_at", datetime.now(UTC).isoformat())
                cfg.set("poll_last_fetched", str(stats.fetched))
                cfg.set("poll_last_processed", str(stats.processed_new))
                cfg.set("poll_last_skipped_done", str(stats.skipped_already_done))
                cfg.set("poll_last_skipped_scope", str(stats.skipped_out_of_scope))
                cfg.set("poll_last_errors", str(stats.errors))
                cfg.set("poll_last_error_message", stats.error_message)
        except Exception as exc:
            logger.warning("poll: état du cycle non persisté (observabilité dégradée): %s", exc)
