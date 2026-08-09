"""Tables SQLModel. Noms `snake_case` pluriel, PK `id`, colonnes `snake_case`.

Note timezone : les colonnes `ts` du Journal et des appels LLM sont **timezone-aware**
(UTC) via `UtcDateTime`. Indispensable pour le portage Postgres futur (audit cybersécu) :
sans ça, comparer `ts < cutoff` casse avec `TypeError: can't compare offset-naive and
offset-aware`. Sur SQLite (TEXT), `UtcDateTime` normalise à la lecture (force aware UTC
même pour les lignes anciennes stockées sans offset).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import Column, Date, DateTime, UniqueConstraint
from sqlalchemy.types import TypeDecorator
from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(UTC)


class UtcDateTime(TypeDecorator):
    """`DateTime(timezone=True)` qui garantit `tzinfo=UTC` à la lecture.

    Anciennes lignes SQLite stockées en naive (avant ce typage) → réhydratées en aware
    UTC, transparent pour le moteur. Sur Postgres, équivaut à `timestamp with time zone`.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        # À l'écriture : un naive est supposé UTC (cohérent avec `_utcnow`).
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        # À la lecture : si SQLite a relu en naive (anciennes lignes), on force UTC.
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value


def _ts_column(*, index: bool = False) -> Column:
    """Colonne `ts` partagée Journal / appels LLM (audit UTC strict)."""
    return Column(UtcDateTime, nullable=False, default=_utcnow, index=index)


class ProcessedTicket(SQLModel, table=True):
    """Idempotence du polling (FR-2).

    Un Ticket déjà traité (présent ici) n'est jamais retraité. La clé est le
    `ticket_id` GLPI ; `state_fingerprint` permet de détecter un changement d'état.

    ⚠️ Fenêtre de crash connue (pas de transaction distribuée avec GLPI) : le poller
    (`scheduler/poller.py`) appelle le handler de triage PUIS `mark_processed`. Un arrêt
    brutal ENTRE les deux laisse l'écriture GLPI faite sans marquage local → le Ticket est
    repris au cycle suivant. Impact selon le mode du périmètre :
    - `suggestion` (défaut) → au pire un Suivi interne PRIVÉ en double (aucune mutation,
      rien de visible par le demandeur) ;
    - `semi_auto` / `full_auto` → seconde mutation GLPI du Ticket ET seconde réponse
      PUBLIQUE au demandeur.

    Fermer cette fenêtre suppose une re-vérification côté GLPI avant mutation (relire les
    Suivis / l'état du Ticket pour détecter un passage déjà effectué) : **non implémentée
    à ce jour** dans `services/triage.py`.
    """

    __tablename__ = "processed_tickets"

    ticket_id: int = Field(primary_key=True)
    state_fingerprint: str = ""
    followup_written: bool = False
    processed_at: datetime = Field(default_factory=_utcnow, sa_column=_ts_column(index=True))


class LlmCall(SQLModel, table=True):
    """Log exhaustif d'un appel LLM (FR-19).

    ⚠️ `prompt_sent` reflète TOUJOURS le Masquage : aucun motif secret en clair
    (invariant PII). Sert aussi au cost cap (FR-10) via `cost_eur`.
    """

    __tablename__ = "llm_calls"

    id: int | None = Field(default=None, primary_key=True)
    ticket_id: int = Field(index=True)
    ts: datetime = Field(default_factory=_utcnow, sa_column=_ts_column(index=True))
    model: str = ""
    prompt_sent: str = ""  # contenu masqué envoyé
    response_received: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_eur: float = 0.0


class DecisionLog(SQLModel, table=True):
    """Journal de décision (FR-20) : table brute, triable, annotable.

    Une ligne par Ticket traité par le moteur (accepté ou « à trier »). La colonne
    `annotation` permet au technicien de qualifier la Décision (protocole SM, §7).
    Aucune métrique nominative n'est produite (anti-mouchard, FR-21).
    """

    __tablename__ = "decisions"

    id: int | None = Field(default=None, primary_key=True)
    ticket_id: int = Field(index=True)
    ts: datetime = Field(default_factory=_utcnow, sa_column=_ts_column(index=True))
    subject: str = ""  # titre du Ticket GLPI (lisible dans le journal)
    accepted: bool = False
    reason: str = ""  # TriageReason
    category: int | None = None
    priority: int | None = None
    technician_id: int | None = None
    group_id: int | None = None
    confidence: float | None = None
    glpi_link: str = ""
    annotation: str = ""  # éditable a posteriori (revue manuelle pilote)
    # Mode d'exécution effectif + a-t-on muté le Ticket GLPI (vs Suivi seul) — traçabilité.
    mode: str = ""  # ExecutionMode résolu pour le périmètre
    applied: bool = False  # True si la Décision a été appliquée aux champs GLPI
    # Repli : un acteur a été assigné SUR UN REFUS (« à trier »), sans mutation de champ.
    # Colonne DISTINCTE de `applied` à dessein : `accepted=False` reste la vérité d'audit
    # (le garde-fou a bien refusé), et l'admin doit pouvoir compter les tickets routés par
    # repli sans les confondre avec des Décisions appliquées.
    fallback_applied: bool = False


class ReferentialCache(SQLModel, table=True):
    """Référentiels GLPI scannés + sélections de l'admin (cœur du périmètre).

    Un enregistrement par objet GLPI (catégorie, entité, technicien, groupe), rafraîchi
    par un scan GLPI. L'admin choisit ensuite, dans la console, le périmètre que l'IA a
    le droit d'utiliser :
    - `selected` : pour les catégories/entités → autorisée / dans le périmètre.
    - `eligible` : pour les techniciens/groupes → l'IA peut router vers eux.
    - `skills`   : prose libre décrivant le technicien/groupe (routage, FR-15).
    """

    __tablename__ = "referential_cache"
    __table_args__ = (UniqueConstraint("kind", "ext_id", name="uq_referential_kind_ext"),)

    id: int | None = Field(default=None, primary_key=True)
    kind: str = Field(index=True)  # "category" | "entity" | "technician" | "group"
    ext_id: int  # id GLPI
    name: str = ""
    profile: str = ""  # profil(s) GLPI (techniciens) — pour tri/filtre UI
    selected: bool = False  # catégories/entités dans le périmètre
    eligible: bool = False  # techniciens/groupes vers qui l'IA peut router
    skills: str = ""  # prose (techniciens/groupes)
    # Domaines de compétence COCHÉS (clés de `domain.skills`, séparées par des virgules).
    # Stocké à plat plutôt que dans une table de liaison : la cardinalité est minuscule
    # (≤ 14 clés par ligne), la lecture est toujours globale, et une jointure n'apporterait
    # que de la complexité. Complète `skills` sans le remplacer — cf. `routing_prose`.
    skill_tags: str = ""
    # Mode d'exécution par ENTITÉ (kind="entity") : None = défaut global (runtime_config).
    # `auto_min_confidence` = 2e seuil strict du mode semi_auto (None = défaut global).
    mode: str | None = None  # "suggestion" | "semi_auto" | "full_auto"
    auto_min_confidence: float | None = None
    # Cible de REPLI par entité : acteur assigné quand le garde-fou refuse une Décision
    # (« à trier » arbitré). None = pas de repli, le Ticket reste non assigné.
    # Groupe PRÉFÉRÉ au technicien : une personne nommée comme filet de sécurité de toute
    # l'instance est un point de défaillance unique, et entre en collision frontale avec
    # les absences. Un groupe GLPI encaisse l'absence sans configuration.
    fallback_group_id: int | None = None
    fallback_technician_id: int | None = None
    updated_at: datetime = Field(default_factory=_utcnow)


class TechnicianAbsence(SQLModel, table=True):
    """Absence d'un technicien + remplaçant éventuel (routage, FR-15).

    TABLE DÉDIÉE, pas une colonne de plus sur `referential_cache` : un technicien a
    plusieurs absences dans l'année, et une colonne unique obligerait à écraser la
    précédente ou à sérialiser une liste dans une chaîne.

    GRANULARITÉ JOUR, bornes INCLUSES, colonnes `Date` (pas `DateTime`) : une absence est
    posée par un humain dans un calendrier, pas mesurée à la seconde. Stocker un instant
    aurait fait entrer le fuseau dans la BASE, alors qu'il n'a lieu d'intervenir qu'à
    l'ÉVALUATION (« quel jour sommes-nous ici ? », cf. `services/absences.today_local`).

    RGPD — c'est une donnée personnelle (qui est absent, quand). Deux garde-fous :
    - elle est **purgée** avec le reste par la rétention une fois l'absence terminée
      (`services/retention`) : une absence passée n'a plus aucune utilité opérationnelle ;
    - ce n'est PAS une métrique par technicien (anti-mouchard, FR-18/21) : on enregistre
      une DISPONIBILITÉ déclarée par l'admin pour router, jamais une mesure d'activité,
      de performance ou de présence effective.
    """

    __tablename__ = "technician_absences"

    id: int | None = Field(default=None, primary_key=True)
    technician_ext_id: int = Field(index=True)  # id GLPI du technicien absent
    start_date: date = Field(sa_column=Column(Date, nullable=False))
    end_date: date = Field(sa_column=Column(Date, nullable=False))
    # Remplaçant éligible qui absorbe l'intérim (None = personne ; l'absent sort du pool
    # et ses tickets partent vers qui couvre le domaine, ou « à trier »).
    replacement_ext_id: int | None = None
    note: str = ""
    created_at: datetime = Field(default_factory=_utcnow, sa_column=_ts_column())


class AuditLog(SQLModel, table=True):
    """Journal d'AUDIT des actions d'administration (imputabilité — audit 2026-08).

    Pourquoi : jusqu'ici, changer un réglage de gouvernance ne laissait AUCUNE trace.
    Basculer une entité en `full_auto` (l'IA répond publiquement au demandeur), couper le
    masquage PII, mettre la rétention RGPD à 0 ou retirer la licence Supporter étaient des
    actions invisibles — et la purge RGPD effaçait justement la seule table (`decisions`)
    qui aurait pu en témoigner a posteriori. C'est la première pièce demandée par un RSSI :
    « qui a changé quoi, quand, depuis où ? ».

    Alimentée depuis le point de passage UNIQUE des écritures de configuration
    (`RuntimeConfigService.set` / `set_secret`), pour qu'aucun appelant ne puisse écrire
    « en douce » : la trace est produite par le service, pas par les routes.

    ⚠️ Aucune VALEUR SECRÈTE n'est stockée : les secrets (tokens GLPI, clés LLM, hash admin)
    et les clés jugées sensibles (`license_key`) sont consignés comme `***`. On garde
    seulement le fait qu'ils ont été posés ou effacés — ce qui suffit à l'imputabilité
    sans recréer un second entrepôt de secrets en clair.

    RÉTENTION — choix ASSUMÉ : cette table est EXCLUE de la purge RGPD
    (`services/retention.py`, qui ne vise que `decisions` et `llm_calls`). Justification :
    1. ce n'est pas une donnée de TICKET (aucun contenu de demandeur, aucun texte GLPI,
       aucune donnée métier) mais une donnée d'IMPUTABILITÉ, produite pour la sécurité du
       traitement (RGPD art. 5.1.f + art. 32) et l'obligation de rendre des comptes
       (art. 5.2) — la purger avec les tickets détruirait la preuve censée survivre à
       l'incident qu'elle documente ;
    2. la purger sur la même fenêtre que les tickets offrirait un effacement de traces
       trivial : il suffirait de mettre `retention_decisions_days=1` — action justement
       auditée ici — pour faire disparaître l'audit de cette action ;
    3. son volume est négligeable (une ligne par changement d'un réglage d'admin, pas par
       ticket), donc aucune fenêtre n'est nécessaire pour des raisons de place.
    Réserve honnête : `actor` porte une adresse IP, qui EST une donnée à caractère personnel.
    Sa conservation est bornée par la durée de vie de l'instance et doit être déclarée au
    registre des traitements ; si un exploitant veut une fenêtre dédiée (typiquement 12 mois,
    usage courant pour des journaux de sécurité), elle devra être ajoutée EXPLICITEMENT et
    séparément — jamais recollée sur la fenêtre « tickets ».
    """

    __tablename__ = "audit_log"

    id: int | None = Field(default=None, primary_key=True)
    ts: datetime = Field(default_factory=_utcnow, sa_column=_ts_column(index=True))
    # Initiateur : IP du client admin, ou "scheduler"/"cli"/"system" pour les écritures
    # machine. Pas de nom d'utilisateur : le produit n'a qu'un compte admin (FR-24).
    actor: str = Field(default="", index=True)
    action: str = Field(default="", index=True)  # "config.set" | "config.set_secret"
    key: str = Field(default="", index=True)  # clé de configuration touchée
    old_value: str = ""  # "***" si secret/sensible, "" si non défini
    new_value: str = ""  # "***" si secret/sensible, "" si effacé


class RuntimeConfig(SQLModel, table=True):
    """Configuration poussée au runtime via l'API/UI (pas via .env).

    Porte les SECRETS (clé API LLM, tokens GLPI) chiffrés au repos (FR-25) et les
    réglages surchargeables (URLs, modèle, seuils). `is_secret=True` ⇒ `value` est
    un token chiffré opaque ; sinon `value` est en clair.
    """

    __tablename__ = "runtime_config"

    key: str = Field(primary_key=True)
    value: str = ""
    is_secret: bool = False
    updated_at: datetime = Field(default_factory=_utcnow)
