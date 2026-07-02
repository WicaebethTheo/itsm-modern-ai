"""Confidentialité / DPO — état du masquage PII par catégorie + outil de test + rapport.

Reflète FIDÈLEMENT le découpage open-core : sans licence on masque e-mail + téléphone ; IBAN/
cartes, secrets, IP/MAC, NIR/SIRET et regex custom sont gatés Supporter (FEATURE_PII_ADVANCED).
Page destinée à la DPO/RSSI (guide public : https://docs.itsm-modern-ai.com/). Protégé par
l'auth locale (FR-24).
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from ...domain import masking
from ...domain.licensing import FEATURE_PII_ADVANCED
from ...persistence import db, journal
from ...plugins import build_registry
from ...services.license_service import LicenseService
from ...services.runtime_config import RuntimeConfigService
from ..deps import get_config_service
from ..security import require_auth

router = APIRouter(prefix="/api/privacy", tags=["privacy"], dependencies=[Depends(require_auth)])


class PiiCategory(BaseModel):
    key: str
    label_fr: str
    label_en: str
    example: str
    scope: str  # "community" | "supporter" | "roadmap" (capacité pas encore livrée)
    active: bool  # réellement masqué dans l'état courant


class PrivacyView(BaseModel):
    edition_advanced: bool  # FEATURE_PII_ADVANCED actif (image + licence)
    categories: list[PiiCategory]
    retention_decisions_days: int
    retention_llm_calls_days: int
    llm_calls_count: int


class MaskTestIn(BaseModel):
    text: str


class MaskTestOut(BaseModel):
    masked: str
    counts: dict[str, int]


def _state(request: Request, cfg: RuntimeConfigService):
    """Calcule pii_advanced + flags + masker avancé (même logique que le pipeline)."""
    registry = build_registry()
    advanced = (
        FEATURE_PII_ADVANCED in registry.installed_features()
        and LicenseService(cfg).has_feature(FEATURE_PII_ADVANCED)
    )
    s = cfg.settings
    flags = {
        "email": cfg.get_bool("mask_email", s.mask_email),
        "phone": cfg.get_bool("mask_phone", s.mask_phone),
        "iban": advanced and cfg.get_bool("mask_iban", s.mask_iban),
        "secret": advanced and cfg.get_bool("mask_secret", s.mask_secret),
        "network": advanced,
    }
    masker = registry.provider(FEATURE_PII_ADVANCED) if advanced else None
    return advanced, flags, masker


def _categories(advanced: bool, flags: dict[str, bool]) -> list[PiiCategory]:
    return [
        PiiCategory(key="email", label_fr="Adresses e-mail", label_en="Email addresses",
                    example="alice@acme.com", scope="community", active=flags["email"]),
        PiiCategory(key="phone", label_fr="Numéros de téléphone", label_en="Phone numbers",
                    example="+33 6 12 34 56 78", scope="community", active=flags["phone"]),
        PiiCategory(key="iban", label_fr="IBAN & cartes bancaires", label_en="IBAN & payment cards",
                    example="FR76 3000 4000 …", scope="supporter", active=flags["iban"]),
        PiiCategory(key="secret", label_fr="Secrets (tokens, mots de passe, clés API)",
                    label_en="Secrets (tokens, passwords, API keys)", example="sk-•••••, Bearer •••",
                    scope="supporter", active=flags["secret"]),
        PiiCategory(key="network", label_fr="Adresses IP & MAC", label_en="IP & MAC addresses",
                    example="10.0.1.42, a4:5e:60:…", scope="supporter", active=flags["network"]),
        PiiCategory(key="nir_siret", label_fr="NIR / SIRET", label_en="NIR / SIRET",
                    example="1 85 12 …, 552 120 …", scope="supporter", active=advanced),
        # Patterns regex personnalisés : la capacité existe dans l'overlay (AdvancedPiiMasker
        # .from_rules) mais n'est pas encore exposée à la configuration → jamais active en prod.
        # Annoncé « à venir » (roadmap), jamais « masqué », pour ne pas tromper la DPO.
        PiiCategory(key="custom", label_fr="Patterns personnalisés (regex)",
                    label_en="Custom patterns (regex)", example="TICKET-\\d{5}",
                    scope="roadmap", active=False),
    ]


@router.get("", response_model=PrivacyView)
def privacy(request: Request, cfg: RuntimeConfigService = Depends(get_config_service)) -> PrivacyView:
    advanced, flags, _ = _state(request, cfg)
    s = cfg.settings
    with db.session_scope() as session:
        n = journal.count_llm_calls(session)
    return PrivacyView(
        edition_advanced=advanced,
        categories=_categories(advanced, flags),
        retention_decisions_days=cfg.get_int("retention_decisions_days", s.retention_decisions_days),
        retention_llm_calls_days=cfg.get_int("retention_llm_calls_days", s.retention_llm_calls_days),
        llm_calls_count=n,
    )


@router.post("/test-mask", response_model=MaskTestOut)
def test_mask(
    payload: MaskTestIn, request: Request, cfg: RuntimeConfigService = Depends(get_config_service)
) -> MaskTestOut:
    """Applique le masquage RÉEL (état courant + édition) à un texte d'exemple — outil DPO."""
    _, flags, masker = _state(request, cfg)
    result = masking.mask(payload.text, **flags)
    out = masker.mask(result.text) if masker is not None else result.text
    return MaskTestOut(masked=out, counts=result.counts)


@router.get("/report.md")
def dpo_report(request: Request, cfg: RuntimeConfigService = Depends(get_config_service)) -> Response:
    """Rapport DPO téléchargeable (Markdown) : édition, catégories masquées, rétention."""
    advanced, flags, _ = _state(request, cfg)
    cats = _categories(advanced, flags)
    s = cfg.settings
    with db.session_scope() as session:
        n = journal.count_llm_calls(session)
    edition = "Supporter" if advanced else "Community"
    lines = [
        "# Rapport DPO — ITSM Modern AI",
        f"_Généré le {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')} · édition {edition}_",
        "",
        "## Masquage PII avant tout appel LLM",
        "",
        "| Catégorie | Exemple | Statut |",
        "|---|---|---|",
    ]
    for c in cats:
        if c.active:
            status = "Masqué"
        elif c.scope == "roadmap":
            status = "À venir (non implémenté)"
        elif c.scope == "supporter":
            status = "VERROUILLÉ (Supporter)"
        else:
            status = "Désactivé"
        lines.append(f"| {c.label_fr} | `{c.example}` | {status} |")
    lines += [
        "",
        "> Le masquage est basé sur des expressions régulières — **pas** une anonymisation "
        "(noms/adresses non couverts).",
        "" if advanced else
        "> ⚠️ Édition Community : IBAN, secrets, IP/MAC et NIR/SIRET **ne sont pas masqués** "
        "et sont transmis EN CLAIR au LLM (et conservés en clair dans le journal).",
        "",
        "## Rétention (purge RGPD)",
        f"- Décisions (Journal) : **{cfg.get_int('retention_decisions_days', s.retention_decisions_days)} jours**",
        f"- Appels LLM (`llm_calls`) : **{cfg.get_int('retention_llm_calls_days', s.retention_llm_calls_days)} jours**",
        f"- Appels LLM journalisés à ce jour : **{n}**",
    ]
    body = "\n".join(lines) + "\n"
    return Response(
        content=body,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="dpo-report.md"'},
    )
