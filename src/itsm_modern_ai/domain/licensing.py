"""Vérification de licence Supporter — Ed25519, 100 % hors-ligne (zéro phone-home).

Modèle « open-core » à édition unique : le code des features Supporter EST livré dans
cette image (package `itsm_modern_ai.features`) mais reste verrouillé. Cette licence ne
*télécharge* rien — elle **débloque** ce qui est déjà installé.

Format d'un jeton de licence (compact, type PASETO simplifié) :

    itsm-lic.v1.<b64url(payload_json)>.<b64url(signature_ed25519)>

Le `payload_json` est sérialisé canoniquement (clés triées, sans espaces). La signature
porte sur les octets `v1.<b64url(payload)>` (le contexte de version est signé pour
empêcher tout downgrade). Seule la **clé publique** est embarquée ici ; la clé privée
de signature reste côté éditeur (outil de signature du dépôt de licence privé).

⚠️ Garde-fous de sécurité honnêtes (cf. discussion produit) : une licence côté client
est un *frein contractuel*, pas un DRM inviolable.

Module PUR : aucune I/O, aucun import d'adaptateur. Testable en isolation.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from datetime import date, datetime

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# ── Clé publique de l'éditeur (embarquée) ──────────────────────────────────────
# Raw Ed25519 public key (32 octets, hex). La clé PRIVÉE correspondante vit
# UNIQUEMENT dans l'outil de signature du dépôt de licence privé — jamais ici.
# Paire en service depuis la 0.9.44 ; les jetons antérieurs doivent être ré-émis
# (contact : support@itsm-modern-ai.com).
PUBLISHER_PUBLIC_KEY_HEX = "0d9cf5c9f75a884d139d82064a2f07cae91fbc7e0163433458b5b11037065465"

_TOKEN_PREFIX = "itsm-lic"
_TOKEN_VERSION = "v1"


# ── Catalogue des features Supporter (clés + métadonnées pour l'UI) ────────────
# Le core déclare les CLÉS et leurs métadonnées (pour la page Supporter) ; les
# implémentations sont fournies par le package `itsm_modern_ai.features` intégré.
FEATURE_PII_ADVANCED = "pii_advanced"
FEATURE_MULTI_ENTITY = "multi_entity"
FEATURE_SCHEDULED_EXPORTS = "scheduled_exports"


@dataclass(frozen=True)
class FeatureSpec:
    """Métadonnées d'une feature gateable (rendu générique de la page Store)."""

    key: str
    label_fr: str
    label_en: str
    description_fr: str
    description_en: str


FEATURE_CATALOG: tuple[FeatureSpec, ...] = (
    FeatureSpec(
        key=FEATURE_PII_ADVANCED,
        label_fr="Masquage PII avancé",
        label_en="Advanced PII masking",
        description_fr=(
            "Masquage des IBAN/cartes et des secrets (mots de passe, tokens, clés API) "
            "et identifiants FR (NIR, SIRET). En Community, seuls e-mail et téléphone "
            "sont masqués. Patterns regex personnalisés et règles par entité : roadmap."
        ),
        description_en=(
            "Masking of IBANs/cards, secrets (passwords, tokens, API keys) and French "
            "identifiers (NIR, SIRET). In Community, only email and phone are masked. "
            "Custom regex patterns and per-entity rules: roadmap."
        ),
    ),
    FeatureSpec(
        key=FEATURE_MULTI_ENTITY,
        label_fr="Multi-entités avancé (à venir)",
        label_en="Advanced multi-entity (coming soon)",
        description_fr=(
            "À VENIR. Gestion fine multi-entités : politiques de triage et seuils par "
            "entité, héritage hiérarchique, tableaux de bord par entité."
        ),
        description_en=(
            "COMING SOON. Fine-grained multi-entity management: per-entity triage "
            "policies and thresholds, hierarchical inheritance, per-entity dashboards."
        ),
    ),
    FeatureSpec(
        key=FEATURE_SCHEDULED_EXPORTS,
        label_fr="Exports planifiés / DPO+ (à venir)",
        label_en="Scheduled exports / DPO+ (coming soon)",
        description_fr=(
            "À VENIR. Exports CSV planifiés (cron), rapports DPO enrichis et envois "
            "automatiques. L'export CSV manuel reste inclus en Community."
        ),
        description_en=(
            "COMING SOON. Scheduled CSV exports (cron), enriched DPO reports and "
            "automated delivery. Manual CSV export stays in Community."
        ),
    ),
)

KNOWN_FEATURES: frozenset[str] = frozenset(spec.key for spec in FEATURE_CATALOG)


@dataclass(frozen=True)
class License:
    """Charge utile vérifiée d'une licence."""

    customer: str
    edition: str  # "supporter"
    features: frozenset[str]
    issued_at: date | None = None
    expires_at: date | None = None

    def is_expired(self, today: date) -> bool:
        return self.expires_at is not None and today > self.expires_at


@dataclass(frozen=True)
class LicenseStatus:
    """Résultat de vérification — toujours exploitable (jamais d'exception remontée)."""

    edition: str  # "community" | "supporter"
    valid: bool
    features: frozenset[str] = frozenset()
    customer: str | None = None
    issued_at: date | None = None
    expires_at: date | None = None
    error: str | None = None  # raison si invalide (jamais affiché comme secret)
    catalog: tuple[FeatureSpec, ...] = field(default=FEATURE_CATALOG)

    @property
    def is_supporter(self) -> bool:
        return self.valid and self.edition == "supporter"

    def has_feature(self, key: str) -> bool:
        return self.valid and key in self.features


COMMUNITY_STATUS = LicenseStatus(edition="community", valid=False)


# Garde-fou de taille : un jeton légitime fait quelques centaines d'octets. On refuse
# au-delà pour éviter un parse coûteux (b64 + json) d'une entrée géante (DoS parse).
_MAX_TOKEN_LEN = 8192


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _parse_date(value: object) -> date | None:
    if not value:
        return None
    if isinstance(value, str):
        # Tolère "YYYY-MM-DD" ou ISO complet.
        return datetime.fromisoformat(value).date()
    raise ValueError("date attendue au format ISO (YYYY-MM-DD)")


def _public_key() -> Ed25519PublicKey:
    return Ed25519PublicKey.from_public_bytes(bytes.fromhex(PUBLISHER_PUBLIC_KEY_HEX))


def verify_license(token: str, *, today: date) -> LicenseStatus:
    """Vérifie un jeton de licence hors-ligne. Ne lève jamais : renvoie un LicenseStatus.

    Échecs possibles → `valid=False` + `error` explicite (format, signature, expiration).
    """
    token = (token or "").strip()
    if not token:
        return COMMUNITY_STATUS
    if len(token) > _MAX_TOKEN_LEN:
        return LicenseStatus(edition="community", valid=False, error="jeton trop volumineux")

    parts = token.split(".")
    if len(parts) != 4 or parts[0] != _TOKEN_PREFIX or parts[1] != _TOKEN_VERSION:
        return LicenseStatus(edition="community", valid=False, error="format de jeton invalide")

    _, version, payload_b64, sig_b64 = parts
    signed_message = f"{version}.{payload_b64}".encode()
    try:
        signature = _b64url_decode(sig_b64)
        _public_key().verify(signature, signed_message)
    except InvalidSignature:
        return LicenseStatus(edition="community", valid=False, error="signature invalide")
    except Exception:
        return LicenseStatus(edition="community", valid=False, error="jeton illisible")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
        customer = str(payload["customer"])
        edition = str(payload.get("edition", "supporter"))
        raw_features = payload.get("features", [])
        if not isinstance(raw_features, list):
            raise ValueError("features doit être une liste")
        features = frozenset(str(f) for f in raw_features) & KNOWN_FEATURES
        issued_at = _parse_date(payload.get("issued_at"))
        expires_at = _parse_date(payload.get("expires_at"))
    except Exception:
        return LicenseStatus(edition="community", valid=False, error="charge utile illisible")

    lic = License(
        customer=customer,
        edition=edition,
        features=features,
        issued_at=issued_at,
        expires_at=expires_at,
    )
    if lic.is_expired(today):
        return LicenseStatus(
            edition="community",
            valid=False,
            customer=customer,
            issued_at=issued_at,
            expires_at=expires_at,
            error="licence expirée",
        )

    return LicenseStatus(
        edition=edition,
        valid=True,
        features=features,
        customer=customer,
        issued_at=issued_at,
        expires_at=expires_at,
    )
