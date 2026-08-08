"""Mapper GLPI (FR-4) — encodage statut + payload Suivi (rename 9.x/10.x)."""

from __future__ import annotations

import pytest

from itsm_modern_ai.adapters.itsm.glpi import mapper


def test_is_new_only_status_1():
    assert mapper.is_new({"status": 1})
    assert not mapper.is_new({"status": 2})
    assert not mapper.is_new({})


def test_ticket_mapping():
    t = mapper.ticket_from_glpi({"id": "42", "name": "Souci", "content": "PC lent"})
    assert t.id == 42
    assert t.title == "Souci"
    assert t.content == "PC lent"


def test_followup_itemtype_rename():
    assert mapper.followup_itemtype(False) == "ITILFollowup"  # 10.x+
    assert mapper.followup_itemtype(True) == "TicketFollowup"  # 9.x


def test_followup_payload_modern_uses_itemtype_items_id():
    p = mapper.followup_payload(7, "note", private=True, legacy_9x=False)["input"]
    assert p["itemtype"] == "Ticket"
    assert p["items_id"] == 7
    assert p["is_private"] == 1
    assert "tickets_id" not in p


def test_followup_payload_legacy_uses_tickets_id():
    p = mapper.followup_payload(7, "note", private=True, legacy_9x=True)["input"]
    assert p["tickets_id"] == 7
    assert "items_id" not in p


# ── Normalisation du HTML GLPI (validé contre une instance GLPI 11.0.7 réelle) ──
# GLPI stocke le texte des tickets en HTML : balisage et ENTITÉS. L'éditeur insère
# `&nbsp;` automatiquement et la typographie française en met une avant les deux-points.
# Les motifs de masquage attendent des espaces : sans normalisation, la donnée sensible
# part EN CLAIR au LLM. Ces cas viennent de tickets réels.
def test_plain_text_decode_les_entites_et_retire_le_balisage():
    from itsm_modern_ai.adapters.itsm.glpi.mapper import plain_text

    assert plain_text("<p>Je n&#039;ai plus internet</p>") == "Je n'ai plus internet"
    assert plain_text("ligne 1<br>ligne 2") == "ligne 1\nligne 2"
    assert plain_text("<p>a</p><p>b</p>") == "a\nb"
    assert plain_text("") == ""
    # Une entité écrite par l'utilisateur ne doit pas devenir une balise qu'on retirerait.
    assert plain_text("il a tapé &lt;script&gt; dans le champ") == "il a tapé <script> dans le champ"


@pytest.mark.parametrize(
    ("brut", "attendu_masque", "fuite_interdite"),
    [
        ("Mon num&nbsp;06&nbsp;12&nbsp;34&nbsp;56&nbsp;78", "[PHONE]", "06"),
        ("mot de passe&nbsp;: Azerty1234", "[SECRET]", "Azerty1234"),
        ("<p>Contact&nbsp;: jean.dupont@exemple.fr</p>", "[EMAIL]", "jean.dupont@"),
    ],
)
def test_le_masquage_survit_a_l_encodage_html_de_glpi(brut, attendu_masque, fuite_interdite):
    """Régression : l'espace insécable HTML mettait le masquage en échec.

    `&nbsp;` est inséré automatiquement par l'éditeur de GLPI — c'est la forme NORMALE
    d'un numéro ou d'un « mot de passe : … » collé dans un ticket, pas un cas tordu.
    """
    from itsm_modern_ai.adapters.itsm.glpi.mapper import plain_text
    from itsm_modern_ai.domain import masking

    masque = masking.mask(plain_text(brut)).text
    assert attendu_masque in masque
    assert fuite_interdite not in masque


def test_ticket_from_glpi_normalise_titre_et_contenu():
    """Le Ticket du domaine ne doit jamais porter de HTML : ni pour le LLM, ni pour le Journal."""
    from itsm_modern_ai.adapters.itsm.glpi.mapper import ticket_from_glpi

    t = ticket_from_glpi(
        {"id": 191, "name": "Je n&#039;ai plus internet", "content": "<p>tel&nbsp;06 12 34 56 78</p>",
         "status": 1, "entities_id": 0}
    )
    assert t.title == "Je n'ai plus internet"
    assert "<p>" not in t.content and "&nbsp;" not in t.content
