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
