"""Journal de décision + log des appels LLM (FR-19/20/21)."""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime, timedelta

from sqlmodel import Session, and_, delete, func, or_, select

from ..domain.models import TriageOutcome
from .tables import DecisionLog, LlmCall, _utcnow

DEFAULT_DECISIONS_LIMIT = 500
"""Limite par défaut pour list_decisions (Journal de Décision). Partagée avec l'API."""

# Caractères qui, en tête de cellule, déclenchent une formule dans Excel/LibreOffice/
# Google Sheets (CSV injection / formula injection). On les neutralise par préfixe '.
_CSV_FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")


def _csv_safe(value: object) -> object:
    """Neutralise l'injection de formule CSV (durcissement audit 2026-05).

    Si la cellule (rendue en str) commence par un caractère déclencheur de formule,
    on la préfixe d'une apostrophe pour la forcer en texte. Les valeurs non-str
    (int/float/bool/None) sont renvoyées telles quelles (aucun risque).
    """
    if not isinstance(value, str):
        return value
    if value and value[0] in _CSV_FORMULA_TRIGGERS:
        return "'" + value
    return value


def _bulk_delete_count(session: Session, stmt) -> int:
    """Exécute un DELETE en masse et retourne le nombre de lignes supprimées (atomique)."""
    res = session.exec(stmt)
    session.commit()
    return int(res.rowcount or 0)


def record_llm_call(
    session: Session,
    *,
    ticket_id: int,
    model: str,
    prompt_sent: str,
    response_received: str,
    prompt_tokens: int,
    completion_tokens: int,
    cost_eur: float,
) -> None:
    """Journalise un appel LLM (FR-19). `prompt_sent` DOIT être masqué."""
    session.add(
        LlmCall(
            ticket_id=ticket_id,
            model=model,
            prompt_sent=prompt_sent,
            response_received=response_received,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cost_eur=cost_eur,
        )
    )
    session.commit()


def record_decision(
    session: Session,
    ticket_id: int,
    outcome: TriageOutcome,
    *,
    glpi_link: str = "",
    mode: str = "",
    applied: bool = False,
    subject: str = "",
    fallback_applied: bool = False,
) -> int:
    """Consigne une Décision (acceptée ou « à trier ») dans le Journal (FR-20).

    `mode` = mode d'exécution effectif ; `applied` = la Décision a-t-elle muté le Ticket
    GLPI (vs Suivi seul) ; `subject` = titre du Ticket (lisibilité). Traçabilité (audit/DPO).

    `fallback_applied` = un acteur de repli a été assigné sur un REFUS. Distinct de
    `applied` : la Décision reste refusée (`accepted=False`), aucun champ n'a été muté —
    c'est un aiguillage, pas une application.
    """
    d = outcome.decision
    row = DecisionLog(
        ticket_id=ticket_id,
        subject=subject,
        accepted=outcome.accepted,
        reason=outcome.reason.value,
        category=d.category if d else None,
        priority=d.priority if d else None,
        technician_id=d.technician_id if d else None,
        group_id=d.group_id if d else None,
        confidence=d.confidence if d else None,
        glpi_link=glpi_link,
        mode=mode,
        applied=applied,
        fallback_applied=fallback_applied,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row.id  # type: ignore[return-value]


def list_decisions(session: Session, *, limit: int = DEFAULT_DECISIONS_LIMIT) -> list[DecisionLog]:
    return list(
        session.exec(select(DecisionLog).order_by(DecisionLog.ts.desc()).limit(limit)).all()
    )


def set_annotation(session: Session, decision_id: int, annotation: str) -> DecisionLog | None:
    row = session.get(DecisionLog, decision_id)
    if row is None:
        return None
    row.annotation = annotation
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def count_llm_calls(session: Session) -> int:
    return int(session.exec(select(func.count()).select_from(LlmCall)).one())


def purge_decisions_before(session: Session, cutoff: datetime) -> int:
    """Supprime les Décisions de Journal antérieures à `cutoff` (atomique, via rowcount)."""
    return _bulk_delete_count(session, delete(DecisionLog).where(DecisionLog.ts < cutoff))


def purge_llm_calls_before(session: Session, cutoff: datetime) -> int:
    """Supprime les appels LLM antérieurs à `cutoff` (atomique, via rowcount)."""
    return _bulk_delete_count(session, delete(LlmCall).where(LlmCall.ts < cutoff))


def avg_confidence(session: Session) -> float | None:
    """Confiance moyenne des Décisions (confidence non nulle). None si aucune."""
    val = session.exec(
        select(func.avg(DecisionLog.confidence)).where(DecisionLog.confidence.is_not(None))
    ).one()
    return round(float(val), 3) if val is not None else None


def daily_series(session: Session, days: int = 14) -> list[dict]:
    """Série quotidienne (déposées vs « à trier ») sur les `days` derniers jours.

    Renvoie une entrée par jour (zéros inclus), du plus ancien au plus récent.
    """
    now = _utcnow()
    start_day = (now - timedelta(days=days - 1)).date()
    buckets = {(start_day + timedelta(days=i)).isoformat(): [0, 0] for i in range(days)}
    rows = session.exec(
        select(DecisionLog.ts, DecisionLog.accepted).where(
            DecisionLog.ts >= datetime.combine(start_day, datetime.min.time(), tzinfo=UTC)
        )
    ).all()
    for ts, accepted in rows:
        key = ts.date().isoformat()
        if key in buckets:
            buckets[key][0 if accepted else 1] += 1
    return [
        {"date": d, "accepted": v[0], "a_trier": v[1]} for d, v in sorted(buckets.items())
    ]


def decision_stats(session: Session) -> dict:
    """Métriques d'équipe pour le dashboard (FR-23) — JAMAIS par technicien (anti-mouchard).

    Volontairement orienté santé opérationnelle (taux « à trier », répartition des
    raisons), pas une vanity-metric « X tickets traités par l'IA » (contre-métrique SM-C1).

    ⚠️ Agrégats calculés PAR LA BASE (COUNT + GROUP BY), pas en Python. La version
    précédente faisait un `SELECT *` de tout le Journal — donc hydratait un objet ORM par
    Décision, colonnes `subject`/`annotation`/`glpi_link` comprises — à CHAQUE affichage du
    dashboard, pour n'en tirer que trois compteurs. Sur un journal d'un an de production
    c'est des centaines de Mo transférés et instanciés pour rien, en concurrence avec le
    poller sur la même base. Le GROUP BY donne exactement les mêmes nombres à coût constant
    en mémoire (une ligne par `reason`, soit une dizaine).
    """
    total = int(session.exec(select(func.count()).select_from(DecisionLog)).one())
    accepted = int(
        session.exec(
            select(func.count()).select_from(DecisionLog).where(DecisionLog.accepted.is_(True))
        ).one()
    )
    reason_rows = session.exec(
        select(DecisionLog.reason, func.count()).group_by(DecisionLog.reason)
    ).all()
    # Tri décroissant par volume ; `reason` en second critère pour un ORDRE STABLE (le SGBD
    # ne garantit aucun ordre sur un GROUP BY, et un dashboard qui permute ses lignes à
    # chaque rafraîchissement passe pour instable).
    by_reason = {r: int(n) for r, n in sorted(reason_rows, key=lambda kv: (-kv[1], kv[0]))}
    return {
        "total": total,
        "accepted": accepted,
        "a_trier": total - accepted,
        "useful_coverage": round(accepted / total, 3) if total else 0.0,
        "by_reason": by_reason,
    }


# Taille de lot de l'export en flux : le journal est parcouru par pages de `_CSV_BATCH`
# lignes, jamais d'un seul bloc. 100 lignes × quelques ko de prompt ≈ moins d'1 Mo vivant
# à un instant donné → pic mémoire CONSTANT quel que soit le volume total du journal.
_CSV_BATCH = 100


def _csv_stream(header: list[str], rows: Iterable[Iterable[object]]) -> Iterator[str]:
    """Rend un CSV par TRANCHES (générateur) au lieu de le construire en un seul str.

    Même neutralisation d'injection de formule (`_csv_safe`) et même quoting que la
    version monolithique — seule la façon de restituer change.
    """
    buf = io.StringIO()
    writer = csv.writer(buf)

    def _vider() -> str:
        chunk = buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        return chunk

    writer.writerow(header)
    for row in rows:
        writer.writerow([_csv_safe(v) for v in row])
        if buf.tell() >= 64 * 1024:  # regroupe les lignes : moins d'aller-retours ASGI
            yield _vider()
    reste = _vider()
    if reste:
        yield reste


_DECISIONS_CSV_HEADER = [
    "id", "ticket_id", "ts", "accepted", "reason", "category", "priority",
    "technician_id", "group_id", "confidence", "glpi_link", "annotation",
    # `mode` + `applied` : sans eux, le CSV ne permet PAS de distinguer une suggestion
    # (proposition soumise à un technicien) d'une décision individuelle AUTOMATISÉE avec
    # réponse publique au demandeur (`applied=True` en `full_auto`) — c'est-à-dire l'objet
    # même de l'art. 22 RGPD, donc la première chose qu'une DPO doit pouvoir isoler dans un
    # export « pour l'audit ». Ajoutés EN FIN de ligne : les colonnes existantes gardent
    # leur position, un tableur/script d'audit déjà en place ne casse pas.
    # `subject` reste volontairement HORS export (décision assumée : titre de ticket = PII).
    "mode", "applied",
]

_LLM_CALLS_CSV_HEADER = [
    "id", "ticket_id", "ts", "model", "prompt_sent", "response_received",
    "prompt_tokens", "completion_tokens", "cost_eur",
]


def _pages_antechronologiques(session: Session, modele) -> Iterator:
    """Parcourt une table de journal (ts décroissant) PAR PAGES, sans jamais tout charger.

    Pagination par CURSEUR (keyset) sur `(ts, id)` plutôt que `yield_per` : ce dernier ne
    borne la mémoire que si le driver ouvre un curseur serveur, ce qui dépend de la
    configuration du connecteur (psycopg ne le fait pas par défaut) — une borne qui tient
    par accident n'est pas une borne. Un `LIMIT` explicite, lui, borne la mémoire
    inconditionnellement. `id` départage les `ts` égaux : sans ce
    second critère, deux lignes à la même microseconde feraient boucler la pagination (ou
    en sauteraient). `expunge_all()` vide l'identity map entre deux pages : sinon la
    session garderait une référence par ligne déjà lue et la borne serait fictive.
    """
    dernier: tuple[datetime, int] | None = None
    while True:
        stmt = select(modele).order_by(modele.ts.desc(), modele.id.desc()).limit(_CSV_BATCH)
        if dernier is not None:
            ts, ident = dernier
            stmt = stmt.where(or_(modele.ts < ts, and_(modele.ts == ts, modele.id < ident)))
        page = list(session.exec(stmt))
        if not page:
            return
        yield from page
        dernier = (page[-1].ts, page[-1].id)
        del page
        session.expunge_all()


def decisions_csv_stream(session: Session) -> Iterator[str]:
    """Export CSV du Journal pour la DPO (FR-21), en flux. Aucune métrique nominative.

    Paginé lui aussi : les lignes sont légères, mais l'export était plafonné à 100 000
    Décisions SANS le dire — un journal plus fourni produisait un export d'audit amputé en
    silence, ce qu'aucune DPO ne peut détecter en relisant le fichier. Plus de plafond.
    """
    rows = (
        (d.id, d.ticket_id, d.ts.isoformat(), d.accepted, d.reason, d.category,
         d.priority, d.technician_id, d.group_id, d.confidence, d.glpi_link, d.annotation,
         d.mode, d.applied)
        for d in _pages_antechronologiques(session, DecisionLog)
    )
    return _csv_stream(_DECISIONS_CSV_HEADER, rows)


def decisions_csv(session: Session) -> str:
    """Version monolithique (tests / petits volumes) — préfère `decisions_csv_stream`."""
    return "".join(decisions_csv_stream(session))


def llm_calls_csv_stream(session: Session) -> Iterator[str]:
    """Export CSV des appels LLM (FR-19/21), en FLUX. Contenu déjà masqué.

    ⚠️ C'est l'export le plus lourd du produit : chaque ligne porte le prompt masqué ET la
    réponse brute du LLM (plusieurs ko pour un ticket issu d'un collecteur de mails).
    L'ancienne version chargeait TOUTES les lignes ORM puis assemblait un `StringIO`
    complet : mesuré sur 20 000 appels, 71 Mo de sortie pour 270 Mo de pic mémoire — face
    au `memory: 512M` du compose, c'est l'OOM kill, donc un conteneur qui « redémarre tout
    seul » à chaque clic sur Exporter, sans lien visible avec l'export.
    Ici, la lecture est paginée et le CSV rendu par tranches → pic mémoire CONSTANT quel
    que soit le volume. AUCUNE troncature n'est introduite : un export d'audit amputé —
    même annoncé — vaudrait moins qu'un export lent, puisque la DPO doit pouvoir prouver
    l'exhaustivité de la trace.
    """
    rows = (
        (c.id, c.ticket_id, c.ts.isoformat(), c.model, c.prompt_sent, c.response_received,
         c.prompt_tokens, c.completion_tokens, c.cost_eur)
        for c in _pages_antechronologiques(session, LlmCall)
    )
    return _csv_stream(_LLM_CALLS_CSV_HEADER, rows)


def llm_calls_csv(session: Session) -> str:
    """Version monolithique (tests / petits volumes) — préfère `llm_calls_csv_stream`.

    ⚠️ Reconstruit tout l'export en mémoire : ne pas l'utiliser pour servir une requête HTTP.
    """
    return "".join(llm_calls_csv_stream(session))
