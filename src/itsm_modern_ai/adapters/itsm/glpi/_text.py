"""Normalisation du texte GLPI — partagée par les connecteurs legacy ET V2.

Les deux API renvoient le MÊME HTML (vérifié sur une instance GLPI 11.0.7 : titre
`Je n&#039;ai plus internet`, contenu `<p>…</p>`). Dupliquer cette logique dans les
deux mappers garantirait qu'une des copies dérive au prochain correctif — et une
dérive ici, c'est de la PII qui part en clair au LLM.
"""

from __future__ import annotations

import html as _html
import re

# ── Normalisation du texte GLPI ────────────────────────────────────────────────
# GLPI stocke le texte des tickets en HTML (éditeur TinyMCE) : balisage `<p>`, `<br>`,
# et surtout des ENTITÉS — `&#039;` pour une apostrophe, `&nbsp;` pour une espace
# insécable. Or l'éditeur insère `&nbsp;` automatiquement, et la typographie française
# en met une AVANT les deux-points : « mot de passe&nbsp;: Azerty1234 » est donc la
# forme NORMALE d'un mot de passe collé dans un ticket, pas un cas tordu.
#
# ⚠️ C'est un défaut de MASQUAGE, pas de confort. Mesuré sur des données réelles :
#     « 06&nbsp;12&nbsp;34&nbsp;56&nbsp;78 »  → téléphone NON masqué
#     « mot de passe&nbsp;: Azerty1234 »      → secret NON masqué
# Les motifs du domaine attendent des espaces, pas des entités : sans normalisation,
# la donnée part EN CLAIR au LLM. Normaliser ICI — à la frontière de l'adaptateur, là
# où la représentation GLPI devient du texte du domaine — plutôt que d'apprendre le HTML
# aux regex de masquage, qui doivent rester pures et agnostiques de la source.
#
# Bénéfice second : le LLM reçoit du texte propre au lieu de `<p>` et `&#039;`, ce qui
# améliore la qualité du triage et économise des jetons.
_BR_RE = re.compile(r"(?i)<\s{0,4}br\s{0,4}/?\s{0,4}>")
_BLOCK_END_RE = re.compile(r"(?i)</\s{0,4}(p|div|li|tr|h[1-6])\s{0,4}>")
_TAG_RE = re.compile(r"<[^>]{0,2000}>")
_SPACES_RE = re.compile(r"[ \t\u00a0]{2,}")


def plain_text(raw_html: str) -> str:
    """Convertit le HTML d'un champ GLPI en texte simple, masquable et lisible.

    Quantificateurs BORNÉS (cf. le durcissement ReDoS du masquage) : le contenu vient du
    demandeur, il n'est pas fiable.
    """
    if not raw_html:
        return ""
    texte = _BR_RE.sub("\n", raw_html)
    texte = _BLOCK_END_RE.sub("\n", texte)
    texte = _TAG_RE.sub("", texte)
    # Les entités APRÈS le retrait des balises : `&lt;p&gt;` écrit par un utilisateur ne
    # doit pas devenir une balise que l'on retirerait ensuite.
    texte = _html.unescape(texte)
    # `&nbsp;` devient U+00A0 : on le ramène à une espace ordinaire, sinon les motifs de
    # masquage (qui attendent `\s` ou une espace) le manquent toujours.
    texte = texte.replace("\u00a0", " ")
    texte = _SPACES_RE.sub(" ", texte)
    return "\n".join(ligne.strip() for ligne in texte.split("\n")).strip()
