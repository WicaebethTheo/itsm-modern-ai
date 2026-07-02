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
CARD_PLACEHOLDER = "[CARD]"
IP_PLACEHOLDER = "[IP]"
MAC_PLACEHOLDER = "[MAC]"
CLOUD_KEY_PLACEHOLDER = "[CLOUD_KEY]"

_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")

# IBAN : 2 lettres pays + 2 clés + 11 à 30 caractères (groupes espacés tolérés).
_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b")

# Carte bancaire : 16 chiffres, groupés ou non (séparateurs espace/tiret tolérés).
# La validation Luhn (cf. `_luhn_ok`) évite les faux positifs sur un nombre quelconque
# à 16 chiffres. On limite aux longueurs usuelles (13 à 19 chiffres = PAN ISO/IEC 7812).
_CARD_RE = re.compile(r"(?<![\w-])(?:\d[ -]?){13,19}(?<=\d)(?![\w-])")

# IPv4 : 4 octets 0-255 séparés par des points (ancré pour éviter les versions de type 1.2.3.4.5).
_IPV4_RE = re.compile(
    r"(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}"
    r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.])"
)

# Adresse MAC : 6 paires hexa séparées par ':' ou '-'.
_MAC_RE = re.compile(r"(?<![\w:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![\w:-])")

# Téléphone : FR (+33/0033/0 + 9 chiffres) OU E.164 international (+CC suivi de 8 à 14 chiffres,
# séparateurs espace/point/tiret tolérés). On ancre pour éviter de grignoter d'autres nombres.
_PHONE_RE = re.compile(
    r"(?<!\w)(?:"
    r"(?:\+33|0033)\s?[1-9](?:[\s.\-]?\d{2}){4}"  # FR international
    r"|0[1-9](?:[\s.\-]?\d{2}){4}"  # FR national
    r"|\+[1-9]\d{0,2}(?:[\s.\-]?\d){8,14}"  # E.164 international générique
    r")(?!\w)"
)

# Clé cloud à haute entropie (ex. AWS Access Key ID `AKIA...`, ASIA, ainsi que les
# préfixes Google `AIza`). Ce sont des secrets explicites au format reconnaissable.
_CLOUD_KEY_RE = re.compile(r"\b(?:AKIA|ASIA|AGPA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b")


def _luhn_ok(digits: str) -> bool:
    """Validation Luhn (mod 10) d'une suite de chiffres — anti faux positifs carte."""
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0

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
    network: bool = True,
) -> MaskingResult:
    """Masque les motifs sensibles. Idempotent, sans effet de bord.

    Chaque motif est activable/désactivable (défaut : tous actifs = défaut sûr, FR-14).
    Toggles : `email`, `phone` (Community) ; `iban` (couvre carte bancaire), `secret`
    (couvre clés cloud à haute entropie), `network` (IP/MAC) — ces trois derniers gatés
    Supporter par le pipeline. Défaut `True` partout (masker complet, rétrocompatible).
    ⚠️ Désactiver un motif envoie cette donnée EN CLAIR au LLM — choix explicite de l'admin.
    """
    counts = {
        "email": 0, "phone": 0, "iban": 0, "secret": 0,
        "card": 0, "ip": 0, "mac": 0, "cloud_key": 0,
    }

    def _sub_secret(m: re.Match[str]) -> str:
        if _looks_like_secret(m.group("val")):
            counts["secret"] += 1
            return f"{m.group('kw')}{SECRET_PLACEHOLDER}"
        return m.group(0)

    # Ordre : secret (ancré sur mot-clé) d'abord, pour qu'un token chiffré
    # ne soit pas grignoté par les regex téléphone/IBAN.
    out = _SECRET_KEYWORD_RE.sub(_sub_secret, text) if secret else text

    # Clés cloud (haute entropie, préfixe reconnaissable) : suivent le toggle `secret`.
    if secret:
        def _repl_cloud(_: re.Match[str]) -> str:
            counts["cloud_key"] += 1
            counts["secret"] += 1  # un secret détecté → lève le flag interne
            return CLOUD_KEY_PLACEHOLDER

        out = _CLOUD_KEY_RE.sub(_repl_cloud, out)

    def _count_sub(pattern: re.Pattern[str], placeholder: str, key: str, s: str) -> str:
        def repl(_: re.Match[str]) -> str:
            counts[key] += 1
            return placeholder

        return pattern.sub(repl, s)

    def _luhn_sub(s: str) -> str:
        def repl(m: re.Match[str]) -> str:
            digits = re.sub(r"\D", "", m.group(0))
            if len(digits) >= 13 and _luhn_ok(digits):
                counts["card"] += 1
                return CARD_PLACEHOLDER
            return m.group(0)  # nombre non-Luhn → laissé tel quel (anti faux positif)

        return _CARD_RE.sub(repl, s)

    if email:
        out = _count_sub(_EMAIL_RE, EMAIL_PLACEHOLDER, "email", out)
    if iban:
        out = _count_sub(_IBAN_RE, IBAN_PLACEHOLDER, "iban", out)
    # Carte bancaire (Luhn) AVANT téléphone : un PAN à 16 chiffres ne doit pas être
    # grignoté par la regex téléphone. Suit le toggle `iban` (donnée bancaire).
    if iban:
        out = _luhn_sub(out)
    # IP / MAC : données réseau, toggle `network` dédié (gaté Supporter par le pipeline).
    if network:
        out = _count_sub(_IPV4_RE, IP_PLACEHOLDER, "ip", out)
        out = _count_sub(_MAC_RE, MAC_PLACEHOLDER, "mac", out)
    if phone:
        out = _count_sub(_PHONE_RE, PHONE_PLACEHOLDER, "phone", out)

    return MaskingResult(
        text=out,
        secret_found=counts["secret"] > 0,
        counts={k: v for k, v in counts.items() if v},
    )
