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
from collections.abc import Callable
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
# SIRET (14 chiffres) ou SIREN (9 chiffres), groupes espacés tolérés. Le groupe final
# est GREEDY : un SIRET de 14 chiffres est donc capturé en entier et jamais coupé en un
# faux SIREN de 9 + reliquat.
_SIRET_RE = re.compile(r"(?<!\d)\d{3}[ ]?\d{3}[ ]?\d{3}(?:[ ]?\d{5})?(?!\d)")


def _luhn_ok(digits: str) -> bool:
    """Validation Luhn (mod 10) d'une suite de chiffres.

    Reprend à l'identique l'algorithme de `domain.masking._luhn_ok` (anti faux positifs
    carte bancaire) : on le redéclare ici pour garder ce module de feature autonome et
    pur, sans importer un helper privé du cœur.
    """
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _siret_ok(digits: str) -> bool:
    """Clé de contrôle SIREN (9 chiffres) / SIRET (14 chiffres) : Luhn (règle INSEE).

    Sans cette validation, TOUTE suite de 9 ou 14 chiffres (n° de ticket, n° de série,
    référence fournisseur) partait en `[SIRET]` — faux positifs massifs sur du contenu ITSM.

    ⚠️ Exception connue NON traitée : les SIRET de La Poste (SIREN `356000000`) ne
    suivent pas Luhn mais la règle « somme des chiffres multiple de 5 ». Conséquence
    assumée : un SIRET La Poste n'est pas masqué — faux négatif isolé sur un identifiant
    d'entreprise public, pas sur une donnée personnelle. (Le SIREN `356000000` seul, lui,
    satisfait Luhn et reste masqué.)
    """
    return len(digits) in (9, 14) and _luhn_ok(digits)


def _nir_ok(digits: str) -> bool:
    """Clé de contrôle NIR : les 13 premiers chiffres forment le numéro, les 2 derniers
    la clé, avec `clé = 97 - (numéro mod 97)` (résultat dans 01..97).

    ⚠️ Corse : le calcul officiel remplace les départements `2A`/`2B` par `19`/`18` dans
    le numéro. `_NIR_RE` n'accepte QUE des chiffres → un NIR corse saisi avec sa lettre
    n'est jamais candidat ici, il n'y a donc rien à gérer. Élargir le regex aux lettres
    est hors périmètre (et rouvrirait des faux positifs).
    """
    if len(digits) != 15:
        return False
    return int(digits[13:]) == 97 - (int(digits[:13]) % 97)


def _checked_sub(is_valid: Callable[[str], bool], placeholder: str) -> Callable[[re.Match[str]], str]:
    """Remplace par `placeholder` seulement si la clé de contrôle est valide.

    Même contrat que `_luhn_sub` du cœur : un candidat qui échoue à la validation est
    LAISSÉ TEL QUEL (aucun masquage), pour ne pas caviarder des identifiants métier.
    """

    def repl(m: re.Match[str]) -> str:
        return placeholder if is_valid(m.group(0).replace(" ", "")) else m.group(0)

    return repl


def _siret_sub(m: re.Match[str]) -> str:
    """Substitution SIREN/SIRET avec REPLI sur le préfixe de 9 chiffres.

    ⚠️ Pourquoi ce repli. `_SIRET_RE` est gourmand : sur « SIREN 123456782 12345 unités »
    il capture les 14 chiffres d'un coup (SIREN valide + un nombre voisin). Ces 14
    chiffres échouent à Luhn, et comme le scan reprend APRÈS le match, le SIREN valide
    des 9 premiers chiffres n'était jamais réessayé — il partait EN CLAIR. Un SIREN suivi
    d'une quantité, d'un code postal ou d'un numéro de ligne suffisait à contourner le
    masquage. On retente donc explicitement le préfixe de 9, et on ne masque que lui en
    conservant le reste du texte capturé.
    """
    brut = m.group(0)
    chiffres = brut.replace(" ", "")
    if _siret_ok(chiffres):
        return SIRET_PLACEHOLDER
    # Repli : les 9 premiers chiffres forment-ils un SIREN valide ?
    if len(chiffres) == 14 and _siret_ok(chiffres[:9]):
        # On re-découpe le texte D'ORIGINE (espaces compris) au 9ᵉ chiffre pour ne
        # remplacer que la partie SIREN et restituer le reliquat tel quel.
        vus, coupe = 0, len(brut)
        for i, car in enumerate(brut):
            if car.isdigit():
                vus += 1
                if vus == 9:
                    coupe = i + 1
                    break
        return SIRET_PLACEHOLDER + brut[coupe:]
    return brut


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
        # Ordre : NIR (15 chiffres) AVANT SIRET (9/14) pour qu'un NIR ne soit pas grignoté.
        # Chaque candidat n'est masqué que si sa clé de contrôle est valide (cf. `_checked_sub`).
        # NB : quand un candidat de 14 chiffres échoue à Luhn, le scan reprend APRÈS le match ;
        # ses 9 premiers chiffres ne sont donc pas ré-essayés comme SIREN — voulu, c'est ce
        # qui évite de masquer un « SIREN » au milieu d'un numéro de série plus long.
        out = _NIR_RE.sub(_checked_sub(_nir_ok, NIR_PLACEHOLDER), text)
        out = _SIRET_RE.sub(_siret_sub, out)
        for pattern, placeholder in self.custom_patterns:
            out = pattern.sub(placeholder, out)
        return out


def register(registry) -> None:
    registry.register_feature(FEATURE_PII_ADVANCED, AdvancedPiiMasker())
