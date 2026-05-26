"""Masquage des données sensibles AVANT tout appel LLM (FR-14).

Portée pilote (addendum §D) : email, téléphone, IBAN, mot de passe/token.
⚠️ Ne masque PAS les noms de personnes ni les adresses (regex only ; NER → V2).
Ne pas survendre une « anonymisation » à la DPO (cf. project-context.md invariant 5).

Module PUR (aucune I/O, aucun import d'adaptateur) → testable et réutilisable.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

EMAIL_PLACEHOLDER = "[EMAIL]"
PHONE_PLACEHOLDER = "[PHONE]"
IBAN_PLACEHOLDER = "[IBAN]"
SECRET_PLACEHOLDER = "[SECRET]"

_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")

# IBAN : 2 lettres pays + 2 clés + 11 à 30 caractères (groupes espacés tolérés).
_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b")

# Téléphone FR : +33/0033/0 suivi de 9 chiffres, séparateurs espace/point/tiret tolérés.
_PHONE_RE = re.compile(
    r"(?<!\w)(?:(?:\+33|0033)\s?[1-9]|0[1-9])(?:[\s.\-]?\d{2}){4}(?!\w)"
)

# Mot de passe / token : mot-clé déclencheur puis une chaîne 8+ à classes mixtes.
_SECRET_KEYWORD_RE = re.compile(
    r"(?P<kw>(?:mots?\s*de\s*passe|mot\s*d[e']\s*passe|password|passwd|pwd|mdp|token|secret|cl[ée]\s*api|api[_\s-]?key)\s*[:=]?\s*)"
    r"(?P<val>\S{8,})",
    re.IGNORECASE,
)


def _looks_like_secret(value: str) -> bool:
    """Vrai si `value` a des classes mixtes (≥1 lettre ET ≥1 chiffre)."""
    return bool(re.search(r"[A-Za-z]", value)) and bool(re.search(r"\d", value))


class MaskingResult(BaseModel):
    """Texte masqué + flag d'alerte interne (FR-14)."""

    text: str
    secret_found: bool = False
    counts: dict[str, int] = {}

    @property
    def flag_raised(self) -> bool:
        """Un secret détecté lève un flag interne visible par le technicien."""
        return self.secret_found


def mask(
    text: str,
    *,
    email: bool = True,
    phone: bool = True,
    iban: bool = True,
    secret: bool = True,
) -> MaskingResult:
    """Masque les motifs sensibles. Idempotent, sans effet de bord.

    Chaque motif est activable/désactivable (défaut : tous actifs = défaut sûr, FR-14).
    ⚠️ Désactiver un motif envoie cette donnée EN CLAIR au LLM — choix explicite de l'admin.
    """
    counts = {"email": 0, "phone": 0, "iban": 0, "secret": 0}

    def _sub_secret(m: re.Match[str]) -> str:
        if _looks_like_secret(m.group("val")):
            counts["secret"] += 1
            return f"{m.group('kw')}{SECRET_PLACEHOLDER}"
        return m.group(0)

    # Ordre : secret (ancré sur mot-clé) d'abord, pour qu'un token chiffré
    # ne soit pas grignoté par les regex téléphone/IBAN.
    out = _SECRET_KEYWORD_RE.sub(_sub_secret, text) if secret else text

    def _count_sub(pattern: re.Pattern[str], placeholder: str, key: str, s: str) -> str:
        def repl(_: re.Match[str]) -> str:
            counts[key] += 1
            return placeholder

        return pattern.sub(repl, s)

    if email:
        out = _count_sub(_EMAIL_RE, EMAIL_PLACEHOLDER, "email", out)
    if iban:
        out = _count_sub(_IBAN_RE, IBAN_PLACEHOLDER, "iban", out)
    if phone:
        out = _count_sub(_PHONE_RE, PHONE_PLACEHOLDER, "phone", out)

    return MaskingResult(
        text=out,
        secret_found=counts["secret"] > 0,
        counts={k: v for k, v in counts.items() if v},
    )
