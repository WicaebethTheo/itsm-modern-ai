"""Journal de décision + log des appels LLM (FR-19/20/21)."""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta

from sqlmodel import Session, delete, func, select

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
) -> int:
    """Consigne une Décision (acceptée ou « à trier ») dans le Journal (FR-20).

    `mode` = mode d'exécution effectif ; `applied` = la Décision a-t-elle muté le Ticket
    GLPI (vs Suivi seul) ; `subject` = titre du Ticket (lisibilité). Traçabilité (audit/DPO).
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
    """
    rows = list(session.exec(select(DecisionLog)).all())
    total = len(rows)
    accepted = sum(1 for r in rows if r.accepted)
    by_reason: dict[str, int] = {}
    for r in rows:
        by_reason[r.reason] = by_reason.get(r.reason, 0) + 1
    a_trier = total - accepted
    return {
        "total": total,
        "accepted": accepted,
        "a_trier": a_trier,
        "useful_coverage": round(accepted / total, 3) if total else 0.0,
        "by_reason": dict(sorted(by_reason.items(), key=lambda kv: -kv[1])),
    }


def decisions_csv(session: Session) -> str:
    """Export CSV du Journal pour la DPO (FR-21). Aucune métrique nominative."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["id", "ticket_id", "ts", "accepted", "reason", "category", "priority",
         "technician_id", "group_id", "confidence", "glpi_link", "annotation"]
    )
    for d in list_decisions(session, limit=100_000):
        writer.writerow(
            [_csv_safe(c) for c in
             (d.id, d.ticket_id, d.ts.isoformat(), d.accepted, d.reason, d.category,
              d.priority, d.technician_id, d.group_id, d.confidence, d.glpi_link, d.annotation)]
        )
    return buf.getvalue()


def llm_calls_csv(session: Session) -> str:
    """Export CSV des appels LLM (FR-19/21). Contenu déjà masqué."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["id", "ticket_id", "ts", "model", "prompt_sent", "response_received",
         "prompt_tokens", "completion_tokens", "cost_eur"]
    )
    rows = session.exec(select(LlmCall).order_by(LlmCall.ts.desc())).all()
    for c in rows:
        writer.writerow(
            [_csv_safe(v) for v in
             (c.id, c.ticket_id, c.ts.isoformat(), c.model, c.prompt_sent, c.response_received,
              c.prompt_tokens, c.completion_tokens, c.cost_eur)]
        )
    return buf.getvalue()
