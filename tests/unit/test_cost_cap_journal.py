"""Cost cap (FR-10) + journal/audit (FR-19/20/21)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from itsm_modern_ai.domain.models import Decision, TriageOutcome, TriageReason
from itsm_modern_ai.persistence import db, journal
from itsm_modern_ai.persistence.tables import LlmCall
from itsm_modern_ai.services import cost_cap


def test_cost_eur_formula():
    # 1M tokens in @2€ + 0.5M out @6€ = 2 + 3 = 5€
    assert cost_cap.cost_eur(1_000_000, 500_000, 2.0, 6.0) == 5.0


def test_spent_window_excludes_old_calls(temp_db):
    now = datetime.now(UTC)
    with db.session_scope() as s:
        s.add(LlmCall(ticket_id=1, cost_eur=3.0, ts=now))
        s.add(LlmCall(ticket_id=2, cost_eur=4.0, ts=now - timedelta(hours=25)))  # hors fenêtre
        s.commit()
    with db.session_scope() as s:
        assert cost_cap.spent_last_24h(s, now=now) == 3.0
        assert cost_cap.is_over_cap(s, 5.0, now=now) is False
        assert cost_cap.is_over_cap(s, 2.0, now=now) is True


def test_cap_zero_means_no_cap(temp_db):
    with db.session_scope() as s:
        s.add(LlmCall(ticket_id=1, cost_eur=999.0))
        s.commit()
    with db.session_scope() as s:
        assert cost_cap.is_over_cap(s, 0.0) is False


def test_journal_record_list_annotate(temp_db):
    outcome = TriageOutcome(
        accepted=True,
        reason=TriageReason.ACCEPTED,
        decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9),
    )
    with db.session_scope() as s:
        did = journal.record_decision(s, 42, outcome, glpi_link="http://glpi/ticket?id=42")
    with db.session_scope() as s:
        rows = journal.list_decisions(s)
        assert rows[0].ticket_id == 42 and rows[0].glpi_link.endswith("id=42")
        updated = journal.set_annotation(s, did, "juste, bon routage")
        assert updated.annotation == "juste, bon routage"


def test_decisions_csv_export(temp_db):
    outcome = TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE)
    with db.session_scope() as s:
        journal.record_decision(s, 7, outcome)
    with db.session_scope() as s:
        csv_text = journal.decisions_csv(s)
    assert "ticket_id" in csv_text.splitlines()[0]
    assert "low_confidence" in csv_text


def test_csv_injection_neutralized(temp_db):
    """Une cellule commençant par =/+/-/@ (ou tab/CR) est préfixée d'une apostrophe."""
    outcome = TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE)
    with db.session_scope() as s:
        did = journal.record_decision(s, 7, outcome)
        journal.set_annotation(s, did, "=cmd|'/C calc'!A1")
    with db.session_scope() as s:
        csv_text = journal.decisions_csv(s)
    # Le payload de formule est neutralisé : la cellule est préfixée d'une apostrophe,
    # donc aucune cellule ne commence directement par '='.
    assert "'=cmd|" in csv_text  # préfixé apostrophe
    import csv as _csv

    rows = list(_csv.reader(csv_text.splitlines()))
    assert all(not cell.startswith(("=", "+", "-", "@")) for row in rows for cell in row)

    # Idem export des appels LLM (response_received contrôlable côté LLM).
    with db.session_scope() as s:
        journal.record_llm_call(
            s, ticket_id=1, model="m", prompt_sent="masqué",
            response_received="@SUM(1+1)", prompt_tokens=1, completion_tokens=1, cost_eur=0.0,
        )
    with db.session_scope() as s:
        llm_csv = journal.llm_calls_csv(s)
    assert "'@SUM(1+1)" in llm_csv


def test_decision_stats_agregats_sql(temp_db):
    """Les compteurs du dashboard passent par COUNT/GROUP BY (plus de `SELECT *` du Journal).

    On verrouille les VALEURS (le refactor ne doit rien changer aux nombres affichés) et
    l'ORDRE de `by_reason` : décroissant par volume, puis alphabétique pour que deux
    raisons à égalité ne permutent pas d'un rafraîchissement à l'autre (le SGBD ne
    garantit aucun ordre sur un GROUP BY).
    """
    accepte = TriageOutcome(
        accepted=True,
        reason=TriageReason.ACCEPTED,
        decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9),
    )
    with db.session_scope() as s:
        for i in range(3):
            journal.record_decision(s, i, accepte)
        journal.record_decision(s, 10, TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE))
        journal.record_decision(s, 11, TriageOutcome(accepted=False, reason=TriageReason.LLM_ERROR))
    with db.session_scope() as s:
        stats = journal.decision_stats(s)

    assert stats["total"] == 5 and stats["accepted"] == 3 and stats["a_trier"] == 2
    assert stats["useful_coverage"] == 0.6
    assert stats["by_reason"] == {"accepted": 3, "llm_error": 1, "low_confidence": 1}
    # Ordre stable : volume décroissant, puis alphabétique à égalité.
    assert list(stats["by_reason"]) == ["accepted", "llm_error", "low_confidence"]


def test_decision_stats_journal_vide(temp_db):
    with db.session_scope() as s:
        assert journal.decision_stats(s) == {
            "total": 0, "accepted": 0, "a_trier": 0, "useful_coverage": 0.0, "by_reason": {},
        }


# ── L'export « pour l'audit » doit qualifier la décision (art. 22 RGPD) ──────
def test_decisions_csv_expose_mode_et_applied(temp_db):
    """Sans `mode` ni `applied`, la DPO ne peut pas distinguer, dans le CSV, une simple
    suggestion soumise à un technicien d'une décision individuelle AUTOMATISÉE ayant
    répondu publiquement au demandeur (`applied=True` en `full_auto`) — soit exactement
    ce que l'article 22 lui demande d'identifier.
    """
    import csv as _csv

    accepte = TriageOutcome(
        accepted=True,
        reason=TriageReason.ACCEPTED,
        decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=0.9),
    )
    with db.session_scope() as s:
        journal.record_decision(s, 1, accepte, mode="full_auto", applied=True)
        journal.record_decision(s, 2, accepte, mode="suggestion", applied=False)
    with db.session_scope() as s:
        lignes = list(_csv.DictReader(journal.decisions_csv(s).splitlines()))

    par_ticket = {int(r["ticket_id"]): r for r in lignes}
    assert par_ticket[1]["mode"] == "full_auto" and par_ticket[1]["applied"] == "True"
    assert par_ticket[2]["mode"] == "suggestion" and par_ticket[2]["applied"] == "False"
    # Décision assumée : le titre du Ticket (PII) reste HORS export.
    assert "subject" not in lignes[0]


def test_avg_confidence_and_daily_series(temp_db):
    from itsm_modern_ai.domain.models import Decision

    def acc(conf):
        return TriageOutcome(
            accepted=True, reason=TriageReason.ACCEPTED,
            decision=Decision(category=1, priority=3, technician_id=11, draft="x", confidence=conf),
        )

    with db.session_scope() as s:
        journal.record_decision(s, 1, acc(0.8))
        journal.record_decision(s, 2, acc(1.0))
        journal.record_decision(s, 3, TriageOutcome(accepted=False, reason=TriageReason.LOW_CONFIDENCE))
    with db.session_scope() as s:
        assert journal.avg_confidence(s) == 0.9  # moyenne de 0.8 et 1.0 (None ignoré)
        series = journal.daily_series(s, days=14)
        assert len(series) == 14
        today = series[-1]
        assert today["accepted"] == 2 and today["a_trier"] == 1


# ── L'export des appels LLM ne doit pas tenir tout le fichier en mémoire ─────
def test_llm_calls_csv_stream_borne_la_memoire(temp_db):
    """L'export chargeait TOUTES les lignes puis assemblait un `StringIO` complet :
    mesuré sur 20 000 appels, 71 Mo de sortie pour 270 Mo de pic — face au `memory: 512M`
    du compose, c'est l'OOM kill du conteneur (qui, vu de l'extérieur, « redémarre tout
    seul »). On exige donc un pic mémoire NETTEMENT inférieur à la taille du fichier
    produit : c'est la signature d'un vrai flux, et c'est faux par construction pour
    n'importe quelle implémentation qui accumule.
    """
    import tracemalloc

    charge = "x" * 4_000  # prompt masqué réaliste (ticket issu d'un collecteur de mails)

    def semer(nb: int) -> None:
        with db.session_scope() as s:
            for i in range(nb):
                journal.record_llm_call(
                    s, ticket_id=i, model="m", prompt_sent=charge, response_received=charge,
                    prompt_tokens=1, completion_tokens=1, cost_eur=0.0,
                )

    def exporter() -> tuple[int, int, str]:
        """Consomme le flux SANS l'accumuler (comme l'envoi ASGI) → (octets, pic, entête)."""
        with db.session_scope() as s:
            tracemalloc.start()
            octets, entete = 0, ""
            for i, tranche in enumerate(journal.llm_calls_csv_stream(s)):
                if i == 0:
                    entete = tranche.splitlines()[0]
                octets += len(tranche)
            pic = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
        return octets, pic, entete

    semer(500)
    petit_octets, petit_pic, entete = exporter()
    semer(1_500)  # 4× plus de lignes au total
    gros_octets, gros_pic, _ = exporter()

    assert entete.startswith("id,ticket_id,ts,model,prompt_sent")
    # La PROPRIÉTÉ à tenir : le fichier quadruple, le pic mémoire ne bouge pas. C'est faux
    # par construction pour toute implémentation qui accumule (l'ancienne : ×4 aussi).
    assert gros_octets > 3.5 * petit_octets  # ~4 Mo → ~16 Mo réellement produits
    assert gros_pic < 1.5 * petit_pic, (
        f"pic {gros_pic / 1e6:.1f} Mo pour {gros_octets / 1e6:.1f} Mo de CSV, contre "
        f"{petit_pic / 1e6:.1f} Mo pour {petit_octets / 1e6:.1f} Mo — la mémoire suit le volume"
    )
    # Garde-fou absolu : le pic reste une petite fraction du fichier produit.
    assert gros_pic < gros_octets / 4


def test_llm_calls_csv_stream_identique_au_monolithique(temp_db):
    """Le flux ne doit RIEN changer au contenu : mêmes lignes, même échappement CSV."""
    with db.session_scope() as s:
        for i in range(3):
            journal.record_llm_call(
                s, ticket_id=i, model="m", prompt_sent='du "texte", et\nune ligne',
                response_received="@SUM(1+1)", prompt_tokens=1, completion_tokens=1, cost_eur=0.5,
            )
    with db.session_scope() as s:
        assert "".join(journal.llm_calls_csv_stream(s)) == journal.llm_calls_csv(s)
        assert "'@SUM(1+1)" in journal.llm_calls_csv(s)  # anti-injection préservé


def test_llm_calls_csv_and_count(temp_db):
    with db.session_scope() as s:
        journal.record_llm_call(
            s, ticket_id=1, model="m", prompt_sent="masqué", response_received="{}",
            prompt_tokens=10, completion_tokens=2, cost_eur=0.01,
        )
    with db.session_scope() as s:
        assert journal.count_llm_calls(s) == 1
        assert "prompt_sent" in journal.llm_calls_csv(s)
