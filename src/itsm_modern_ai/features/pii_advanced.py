"""Feature Supporter : masquage PII avancé.

Sans licence, le masquage de base ne couvre QUE l'email et le téléphone ; le masquage
IBAN / cartes / secrets / IP-MAC du cœur est **gaté Supporter** (activé par le pipeline
seulement quand cette feature est installée ET licenciée — cf. `api/runtime.py`). Cette
feature débloque ce masquage du cœur et ajoute par-dessus :
- des identifiants français : NIR (n° de sécurité sociale), SIRET/SIREN ;
- des patterns regex PERSONNALISÉS définis par l'admin (par entité).

Implémentation RÉELLE (module pur, sans I/O) — c'est la feature de référence qui prouve
le mécanisme de gating de bout en bout. Le core fournit `domain.masking.mask` ; ici on
ajoute une passe supplémentaire par-dessus le texte déjà masqué.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from itsm_modern_ai.domain.licensing import FEATURE_PII_ADVANCED

logger = logging.getLogger(__name__)

# Garde-fou de DERNIER RECOURS sur la taille des patterns admin. ⚠️ Il ne protège PAS
# du ReDoS : le coût du backtracking se paie au match (`pattern.sub` sur le texte du
# ticket), et un pattern court comme `(a+)+$` passe ce filtre. Quand la config des
# règles custom sera câblée, la validation devra se faire À LA SAUVEGARDE (422 côté
# API, cf. la couche field_validator de `api/routes/config.py` du cœur) — avec rejet
# des quantificateurs imbriqués ou un moteur sans backtracking, pas seulement ici.
_MAX_PATTERN_LEN = 512

NIR_PLACEHOLDER = "[NIR]"
SIRET_PLACEHOLDER = "[SIRET]"

# NIR : sexe(1) + année(2) + mois(2) + dép(2) + commune(3) + ordre(3) + clé(2) = 15 chiffres,
# groupes espacés tolérés. Ancré pour éviter de grignoter d'autres longues suites.
_NIR_RE = re.compile(r"(?<!\d)[12][ ]?\d{2}[ ]?\d{2}[ ]?\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{2}(?!\d)")
# SIRET (14 chiffres) ou SIREN (9 chiffres), groupes espacés tolérés.
_SIRET_RE = re.compile(r"(?<!\d)\d{3}[ ]?\d{3}[ ]?\d{3}(?:[ ]?\d{5})?(?!\d)")


@dataclass
class AdvancedPiiMasker:
    """Passe de masquage avancée appliquée APRÈS le masquage de base du core."""

    custom_patterns: list[tuple[re.Pattern[str], str]] = field(default_factory=list)

    @classmethod
    def from_rules(cls, rules: list[dict]) -> AdvancedPiiMasker:
        """Construit depuis des règles admin : [{"pattern": "...", "placeholder": "[X]"}].

        ⚠️ Une règle invalide ou trop longue est IGNORÉE (warning) pour ne pas bloquer
        la passe de masquage — c'est un repli, pas une validation : l'appelant qui
        exposera la saisie des règles DOIT rejeter les patterns invalides à la
        sauvegarde (422), sinon l'admin croit masquer une donnée qui part en clair.
        """
        compiled: list[tuple[re.Pattern[str], str]] = []
        for r in rules:
            pattern = r.get("pattern")
            if not pattern:
                continue
            if len(pattern) > _MAX_PATTERN_LEN:
                logger.warning(
                    "Règle de masquage ignorée : pattern trop long (%d > %d).",
                    len(pattern),
                    _MAX_PATTERN_LEN,
                )
                continue
            try:
                regex = re.compile(pattern)
            except re.error as exc:
                # Un pattern admin invalide ne doit pas faire échouer toute la passe de masquage.
                logger.warning("Règle de masquage ignorée : regex invalide (%s).", exc)
                continue
            compiled.append((regex, r.get("placeholder", "[REDACTED]")))
        return cls(custom_patterns=compiled)

    def mask(self, text: str) -> str:
        out = _NIR_RE.sub(NIR_PLACEHOLDER, text)
        out = _SIRET_RE.sub(SIRET_PLACEHOLDER, out)
        for pattern, placeholder in self.custom_patterns:
            out = pattern.sub(placeholder, out)
        return out


def register(registry) -> None:
    registry.register_feature(FEATURE_PII_ADVANCED, AdvancedPiiMasker())
