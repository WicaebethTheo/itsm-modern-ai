"""Masquage PII (FR-14) — chemin critique non-négociable.

Invariant : aucun motif sensible en clair ne doit subsister dans le texte masqué.
"""

from __future__ import annotations

from itsm_modern_ai.domain import masking


def test_masks_email():
    r = masking.mask("Contactez-moi sur jean.martin@exemple.fr svp")
    assert "jean.martin@exemple.fr" not in r.text
    assert masking.EMAIL_PLACEHOLDER in r.text
    assert r.counts.get("email") == 1


def test_pattern_can_be_disabled_selectively():
    text = "IBAN FR7630006000011234567890189 et jean@exemple.fr"
    # IBAN désactivé → reste en clair ; email toujours masqué (indépendance des motifs).
    r = masking.mask(text, iban=False)
    assert "FR7630006000011234567890189" in r.text  # non masqué (toggle off)
    assert "jean@exemple.fr" not in r.text  # masqué (toggle on par défaut)
    assert masking.EMAIL_PLACEHOLDER in r.text


def test_all_patterns_off_leaves_text_intact():
    text = "IBAN FR7630006000011234567890189, mdp: Secret123, 06 12 34 56 78, a@b.fr"
    r = masking.mask(text, email=False, phone=False, iban=False, secret=False)
    assert r.text == text  # aucun masquage
    assert r.counts == {}


def test_masks_french_phone():
    r = masking.mask("mon numéro est 06 12 34 56 78")
    assert "06 12 34 56 78" not in r.text
    assert masking.PHONE_PLACEHOLDER in r.text


def test_masks_iban():
    r = masking.mask("IBAN FR76 3000 4000 0512 3456 7890 143 merci")
    assert "FR76" not in r.text
    assert masking.IBAN_PLACEHOLDER in r.text


def test_masks_secret_and_raises_flag():
    r = masking.mask("mon mdp: Toto2024Ete pour info")
    assert "Toto2024Ete" not in r.text
    assert masking.SECRET_PLACEHOLDER in r.text
    assert r.secret_found is True
    assert r.flag_raised is True


def test_password_label_kept_value_masked():
    r = masking.mask("password=Sup3rSecret99")
    assert "Sup3rSecret99" not in r.text
    assert "password" in r.text.lower()


def test_short_or_pure_word_after_keyword_not_masked_as_secret():
    # "bonjour" n'a pas de classes mixtes → pas un secret.
    r = masking.mask("le mot de passe bonjour ne marche pas")
    assert "bonjour" in r.text
    assert not r.secret_found


def test_no_pii_is_idempotent_noop():
    text = "mon imprimante ne fonctionne plus"
    r = masking.mask(text)
    assert r.text == text
    assert r.counts == {}
    assert not r.secret_found


def test_masking_is_idempotent():
    once = masking.mask("email a@b.fr tel 06 12 34 56 78").text
    twice = masking.mask(once).text
    assert once == twice


# ── Motifs étendus (durcissement audit 2026-05, LLM02) ────────────────────────
def test_masks_credit_card_luhn_valid():
    # 4242 4242 4242 4242 = numéro de test valide Luhn.
    r = masking.mask("paiement par carte 4242 4242 4242 4242 merci")
    assert "4242" not in r.text
    assert masking.CARD_PLACEHOLDER in r.text
    assert r.counts.get("card") == 1


def test_masks_credit_card_with_dashes():
    r = masking.mask("CB 4242-4242-4242-4242")
    assert masking.CARD_PLACEHOLDER in r.text


def test_non_luhn_16_digits_not_masked_as_card():
    """Anti faux positif : un nombre à 16 chiffres non-Luhn n'est PAS une carte."""
    text = "numéro de dossier 1234567890123456 interne"
    r = masking.mask(text)
    assert "1234567890123456" in r.text  # laissé en clair
    assert masking.CARD_PLACEHOLDER not in r.text
    assert "card" not in r.counts


def test_masks_ipv4():
    r = masking.mask("serveur 192.168.1.10 et dns 8.8.8.8")
    assert "192.168.1.10" not in r.text
    assert "8.8.8.8" not in r.text
    assert r.text.count(masking.IP_PLACEHOLDER) == 2
    assert r.counts.get("ip") == 2


def test_invalid_ipv4_octet_not_masked():
    """Anti faux positif : 999.1.1.1 n'est pas une IPv4 valide."""
    r = masking.mask("version 999.1.1.1 du firmware")
    assert masking.IP_PLACEHOLDER not in r.text


def test_masks_mac_address():
    assert masking.MAC_PLACEHOLDER in masking.mask("MAC 00:1A:2B:3C:4D:5E").text
    assert masking.MAC_PLACEHOLDER in masking.mask("MAC AA-BB-CC-DD-EE-FF").text


def test_masks_e164_international_phone():
    r = masking.mask("appelle le +14155552671 stp")
    assert "+14155552671" not in r.text
    assert masking.PHONE_PLACEHOLDER in r.text


def test_masks_cloud_access_key():
    r = masking.mask("ma clé AWS est AKIAIOSFODNN7EXAMPLE pour info")
    assert "AKIAIOSFODNN7EXAMPLE" not in r.text
    assert masking.CLOUD_KEY_PLACEHOLDER in r.text
    # Une clé cloud lève le flag interne « secret détecté ».
    assert r.secret_found is True


def test_extended_patterns_idempotent():
    text = (
        "carte 4242 4242 4242 4242 ip 192.168.1.10 "
        "mac 00:1A:2B:3C:4D:5E tel +14155552671 clé AKIAIOSFODNN7EXAMPLE"
    )
    once = masking.mask(text).text
    twice = masking.mask(once).text
    assert once == twice
    # Plus aucune donnée sensible en clair après masquage.
    for leak in ("4242", "192.168.1.10", "00:1A:2B", "+14155552671", "AKIAIOSFODNN7EXAMPLE"):
        assert leak not in once


def test_card_and_ip_follow_toggles():
    text = "carte 4242 4242 4242 4242 ip 192.168.1.10"
    # iban=False désactive aussi la carte (donnée bancaire) ; network=False l'IP/MAC.
    r = masking.mask(text, iban=False, network=False)
    assert "4242 4242 4242 4242" in r.text
    assert "192.168.1.10" in r.text
    # IP/MAC suivent désormais `network` (et plus `phone`).
    r2 = masking.mask(text, phone=False, network=True)
    assert "[IP]" in r2.text
