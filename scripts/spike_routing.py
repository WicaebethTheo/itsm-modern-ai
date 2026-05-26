#!/usr/bin/env python3
"""Spike de validation — Epic 1 (gate Phase 0).

Mesure si le PARI CENTRAL tient : routage par Fiches techniciens en PROSE +
précision LLM sur des tickets FR mal formulés. Produit justesse, couverture utile,
un seuil de confiance de départ (FR-8) et une conclusion go/no-go (stories 1.2→1.4).

Pipeline (ordre immuable, réutilisé par l'Epic 3) :
    Masquage (FR-14) → LLM JSON mode (FR-6/11) → Pydantic → Whitelist (FR-7) → seuil (FR-8)

Exécution :
    # Mode réel (vraie mesure) — nécessite une clé Mistral EU :
    LLM_API_KEY=... uv run python scripts/spike_routing.py --real
    # Mode mock (offline, vérifie seulement la plomberie — NON représentatif) :
    uv run python scripts/spike_routing.py --mock
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Permet l'exécution directe (`python scripts/spike_routing.py`) sans install.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from itsm_modern_ai.adapters.llm.mock import MockLlm  # noqa: E402
from itsm_modern_ai.adapters.llm.openai_compatible import OpenAiCompatibleLlm  # noqa: E402
from itsm_modern_ai.config.settings import get_settings  # noqa: E402
from itsm_modern_ai.domain import masking, prompting, whitelist  # noqa: E402
from itsm_modern_ai.domain.errors import LlmResponseError, LlmTransportError  # noqa: E402
from itsm_modern_ai.domain.models import Referentials  # noqa: E402
from itsm_modern_ai.ports.llm import LlmPort, LlmResult  # noqa: E402
from itsm_modern_ai.spike_tech_profiles import load_tech_profiles  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURES = REPO / "tests" / "fixtures" / "tickets_fr.json"
DEFAULT_PROFILES = REPO / "tests" / "fixtures" / "tech_profiles_fr.yaml"


@dataclass
class TicketEval:
    """Trace d'évaluation d'un ticket (indépendante du seuil)."""

    id: int
    tags: list[str]
    expected_outcome: str  # "decided" | "a_trier"
    expected_category: int | None
    expected_technician_id: int | None
    expected_priority: int | None
    masked_content: str
    masking_counts: dict[str, int]
    secret_flag: bool
    # Résultat LLM
    error: str | None = None
    category: int | None = None
    priority: int | None = None
    technician_id: int | None = None
    confidence: float = 0.0
    whitelist_ok: bool = False
    whitelist_reason: str | None = None
    tokens: int = 0

    @property
    def routing_correct(self) -> bool:
        """Justesse de routage = catégorie ET technicien attendus (pour cas 'decided')."""
        return (
            self.category == self.expected_category
            and self.technician_id == self.expected_technician_id
        )

    def accepted_at(self, threshold: float) -> bool:
        """La Décision serait-elle acceptée (déposée) à ce seuil ?"""
        return self.error is None and self.whitelist_ok and self.confidence >= threshold


@dataclass
class SpikeReport:
    mode: str
    model: str
    threshold_configured: float
    evals: list[TicketEval] = field(default_factory=list)
    total_cost_eur: float = 0.0


async def _complete_with_retry(llm: LlmPort, system: str, user: str, retries: int = 1) -> LlmResult:
    """1 retry sur erreur transport (FR-9)."""
    last: Exception | None = None
    for _ in range(retries + 1):
        try:
            return await llm.complete(system, user)
        except LlmTransportError as exc:
            last = exc
    raise last  # type: ignore[misc]


async def evaluate_ticket(llm: LlmPort, ticket: dict, refs: Referentials, profiles_prose: str) -> TicketEval:
    raw = f"{ticket.get('title', '')}\n{ticket.get('content', '')}".strip()
    masked = masking.mask(raw)
    ev = TicketEval(
        id=ticket["id"],
        tags=ticket.get("tags", []),
        expected_outcome=ticket.get("expected_outcome", "decided"),
        expected_category=ticket.get("expected_category"),
        expected_technician_id=ticket.get("expected_technician_id"),
        expected_priority=ticket.get("expected_priority"),
        masked_content=masked.text,
        masking_counts=masked.counts,
        secret_flag=masked.flag_raised,
    )

    system = prompting.SYSTEM_PROMPT
    user = prompting.build_user_prompt(masked.text, refs, profiles_prose)

    try:
        result = await _complete_with_retry(llm, system, user)
    except (LlmResponseError, LlmTransportError) as exc:
        ev.error = f"{type(exc).__name__}: {exc}"
        return ev

    d = result.decision
    ev.category, ev.priority, ev.technician_id = d.category, d.priority, d.technician_id
    ev.confidence = d.confidence
    ev.tokens = result.prompt_tokens + result.completion_tokens
    reason = whitelist.check(d, refs)
    ev.whitelist_ok = reason is None
    ev.whitelist_reason = reason.value if reason else None
    return ev


def _sweep_thresholds(evals: list[TicketEval]) -> list[dict]:
    """Balaye les seuils et calcule couverture utile + justesse parmi les acceptés."""
    decided = [e for e in evals if e.expected_outcome == "decided"]
    a_trier = [e for e in evals if e.expected_outcome == "a_trier"]
    rows = []
    for i in range(0, 20):
        t = round(i * 0.05, 2)
        accepted_decided = [e for e in decided if e.accepted_at(t)]
        coverage = len(accepted_decided) / len(decided) if decided else 0.0
        correct = [e for e in accepted_decided if e.routing_correct]
        precision = len(correct) / len(accepted_decided) if accepted_decided else 0.0
        # Faux acceptés : tickets hors-périmètre qui passeraient quand même.
        false_accepts = sum(1 for e in a_trier if e.accepted_at(t))
        good_refusals = len(a_trier) - false_accepts
        rows.append(
            {
                "threshold": t,
                "useful_coverage": round(coverage, 3),
                "routing_accuracy_accepted": round(precision, 3),
                "accepted_decided": len(accepted_decided),
                "false_accepts_out_of_scope": false_accepts,
                "good_refusals": good_refusals,
                "utility": round(coverage * precision, 3),
            }
        )
    return rows


def _suggest_threshold(rows: list[dict]) -> float:
    """Seuil de DÉPART : maximise couverture × justesse, zéro faux-accepté hors-périmètre si possible."""
    safe = [r for r in rows if r["false_accepts_out_of_scope"] == 0]
    pool = safe or rows
    best = max(pool, key=lambda r: (r["utility"], r["useful_coverage"]))
    return best["threshold"]


def build_report(report: SpikeReport, settings) -> dict:
    rows = _sweep_thresholds(report.evals)
    suggested = _suggest_threshold(rows)
    decided = [e for e in report.evals if e.expected_outcome == "decided"]
    a_trier = [e for e in report.evals if e.expected_outcome == "a_trier"]

    t = report.threshold_configured
    accepted_decided = [e for e in decided if e.accepted_at(t)]
    correct = [e for e in accepted_decided if e.routing_correct]
    coverage = len(accepted_decided) / len(decided) if decided else 0.0
    precision = len(correct) / len(accepted_decided) if accepted_decided else 0.0
    false_accepts = sum(1 for e in a_trier if e.accepted_at(t))

    # Masquage : combien de tickets PII ont été correctement masqués.
    pii_tickets = [e for e in report.evals if e.masking_counts]
    masking_total = sum(sum(e.masking_counts.values()) for e in report.evals)

    failures = []
    for e in report.evals:
        if e.expected_outcome == "decided" and e.accepted_at(t) and not e.routing_correct:
            failures.append(
                {
                    "id": e.id,
                    "type": "mauvais_routage",
                    "tags": e.tags,
                    "attendu": {"category": e.expected_category, "technician_id": e.expected_technician_id},
                    "propose": {"category": e.category, "technician_id": e.technician_id},
                    "confidence": e.confidence,
                }
            )
        elif e.expected_outcome == "decided" and not e.accepted_at(t):
            failures.append(
                {
                    "id": e.id,
                    "type": "rate_a_trier",  # aurait dû être décidé
                    "tags": e.tags,
                    "raison": e.error or e.whitelist_reason or "low_confidence",
                    "confidence": e.confidence,
                }
            )
        elif e.expected_outcome == "a_trier" and e.accepted_at(t):
            failures.append(
                {
                    "id": e.id,
                    "type": "faux_accepte_hors_perimetre",
                    "tags": e.tags,
                    "propose": {"category": e.category, "technician_id": e.technician_id},
                    "confidence": e.confidence,
                }
            )

    # Conclusion go/no-go (heuristique — la décision finale reste humaine, cf. PRD §7).
    routing_ok = precision >= 0.75
    coverage_ok = coverage >= 0.6
    safety_ok = false_accepts == 0
    if routing_ok and coverage_ok and safety_ok:
        verdict = "ROUTAGE PROSE VIABLE (à confirmer sur volume réel)"
    elif safety_ok and (routing_ok or coverage_ok):
        verdict = "PROMETTEUR — à affiner (seuil/fiches/prompt) avant conclusion"
    else:
        verdict = "À REVOIR — le différenciateur routage-prose n'est pas démontré en l'état"

    return {
        "mode": report.mode,
        "model": report.model,
        "n_tickets": len(report.evals),
        "threshold_configured": t,
        "summary_at_configured_threshold": {
            "useful_coverage": round(coverage, 3),
            "routing_accuracy_accepted": round(precision, 3),
            "accepted_decided": len(accepted_decided),
            "of_decided": len(decided),
            "false_accepts_out_of_scope": false_accepts,
            "of_out_of_scope": len(a_trier),
        },
        "masking": {
            "tickets_with_pii_masked": len(pii_tickets),
            "total_patterns_masked": masking_total,
            "secret_flags_raised": sum(1 for e in report.evals if e.secret_flag),
        },
        "threshold_sweep": rows,
        "suggested_starting_threshold": suggested,
        "cost_eur_estimated": round(report.total_cost_eur, 4),
        "salient_failures": failures,
        "verdict": verdict,
        "caveat": (
            "Confiance LLM auto-déclarée, NON calibrée (FR-8). Le seuil suggéré est un "
            "point de départ, à affiner sur les Décisions validées du pilote. Échantillon "
            f"de {len(report.evals)} tickets — statistiquement maigre, élargir avant de trancher."
        ),
    }


def render_markdown(r: dict) -> str:
    s = r["summary_at_configured_threshold"]
    lines = [
        "# Spike de routage — synthèse go/no-go (Epic 1)",
        "",
        f"- **Mode** : `{r['mode']}` — modèle `{r['model']}`",
        f"- **Tickets évalués** : {r['n_tickets']}",
        f"- **Seuil configuré** : {r['threshold_configured']}",
        f"- **Seuil de départ suggéré (FR-8)** : **{r['suggested_starting_threshold']}**",
        f"- **Coût estimé du run** : {r['cost_eur_estimated']} €",
        "",
        "## Résultats au seuil configuré",
        "",
        f"- Couverture utile : **{s['useful_coverage']:.0%}** "
        f"({s['accepted_decided']}/{s['of_decided']} tickets à décider ont reçu une Décision)",
        f"- Justesse de routage (parmi acceptés) : **{s['routing_accuracy_accepted']:.0%}**",
        f"- Faux-acceptés hors-périmètre : {s['false_accepts_out_of_scope']}/{s['of_out_of_scope']} "
        "(doit rester à 0)",
        "",
        "## Masquage PII (FR-14)",
        "",
        f"- Tickets avec PII masquée : {r['masking']['tickets_with_pii_masked']}",
        f"- Motifs masqués au total : {r['masking']['total_patterns_masked']}",
        f"- Flags secret levés : {r['masking']['secret_flags_raised']}",
        "",
        "## Calibration du seuil (balayage)",
        "",
        "| seuil | couv. utile | justesse acc. | faux-acc. h.p. | utilité |",
        "|------:|------------:|--------------:|---------------:|--------:|",
    ]
    for row in r["threshold_sweep"]:
        lines.append(
            f"| {row['threshold']:.2f} | {row['useful_coverage']:.0%} | "
            f"{row['routing_accuracy_accepted']:.0%} | {row['false_accepts_out_of_scope']} | "
            f"{row['utility']:.2f} |"
        )
    lines += ["", "## Cas d'échec saillants", ""]
    if not r["salient_failures"]:
        lines.append("_Aucun._")
    for f in r["salient_failures"]:
        detail = {k: v for k, v in f.items() if k not in ("id", "type", "tags")}
        lines.append(
            f"- Ticket {f['id']} — **{f['type']}** {f.get('tags', [])} → "
            f"{json.dumps(detail, ensure_ascii=False)}"
        )
    lines += [
        "",
        "## Verdict",
        "",
        f"**{r['verdict']}**",
        "",
        f"> {r['caveat']}",
        "",
    ]
    return "\n".join(lines)


def make_llm(mode: str, settings, refs: Referentials) -> tuple[LlmPort, str]:
    if mode == "real":
        if not settings.llm_api_key:
            sys.exit("ERREUR : --real exige LLM_API_KEY (clé Mistral EU). Voir .env.example.")
        return (
            OpenAiCompatibleLlm(
                base_url=settings.llm_base_url,
                api_key=settings.llm_api_key,
                model=settings.llm_model,
            ),
            settings.llm_model,
        )
    return MockLlm(refs=refs), "mock-deterministic"


async def run(args: argparse.Namespace) -> int:
    settings = get_settings()
    fixtures = json.loads(Path(args.fixtures).read_text(encoding="utf-8"))
    raw_refs = fixtures["referentials"]
    refs_kwargs = {
        "categories": {int(k): v for k, v in raw_refs["categories"].items()},
        "technicians": {int(k): v for k, v in raw_refs["technicians"].items()},
    }
    if raw_refs.get("priorities"):
        refs_kwargs["priorities"] = {int(k): v for k, v in raw_refs["priorities"].items()}
    refs = Referentials(**refs_kwargs)
    profiles_prose = load_tech_profiles(args.profiles).as_prose()
    tickets = fixtures["tickets"]
    if args.limit:
        tickets = tickets[: args.limit]

    # Auto : réel si une clé est dispo, sinon mock.
    mode = args.mode or ("real" if settings.llm_api_key else "mock")
    llm, model = make_llm(mode, settings, refs)
    threshold = args.threshold if args.threshold is not None else settings.confidence_threshold

    print(f"[spike] mode={mode} modèle={model} tickets={len(tickets)} seuil={threshold}")
    if mode == "mock":
        print("[spike] ⚠️  MODE MOCK : plomberie seulement, NON représentatif de la précision LLM réelle.")

    report = SpikeReport(mode=mode, model=model, threshold_configured=threshold)
    for tk in tickets:
        ev = await evaluate_ticket(llm, tk, refs, profiles_prose)
        report.evals.append(ev)
        report.total_cost_eur += (
            ev.tokens / 1_000_000 * settings.llm_price_input_per_mtok
        )  # approximation (entrée dominante)
        status = "ERREUR" if ev.error else ("ok" if ev.whitelist_ok else f"horsWL:{ev.whitelist_reason}")
        print(f"  - ticket {ev.id}: cat={ev.category} tech={ev.technician_id} conf={ev.confidence:.2f} [{status}]")

    result = build_report(report, settings)
    md = render_markdown(result)

    out_json = Path(args.out_json)
    out_md = Path(args.out_md)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    out_md.write_text(md, encoding="utf-8")

    print("\n" + md)
    print(f"[spike] rapports écrits : {out_json}  +  {out_md}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Spike de routage ITSM Modern AI (Epic 1).")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--real", dest="mode", action="store_const", const="real", help="vrai LLM (clé requise)")
    g.add_argument("--mock", dest="mode", action="store_const", const="mock", help="mock offline")
    p.add_argument("--fixtures", default=str(DEFAULT_FIXTURES))
    p.add_argument("--profiles", default=str(DEFAULT_PROFILES))
    p.add_argument("--threshold", type=float, default=None, help="override du seuil de confiance")
    p.add_argument("--limit", type=int, default=0, help="limiter le nombre de tickets")
    p.add_argument("--out-json", default=str(REPO / "spike-report.json"))
    p.add_argument("--out-md", default=str(REPO / "spike-report.md"))
    args = p.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
