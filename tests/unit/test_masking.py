"""Masquage PII (FR-14) — chemin critique non-négociable.

Invariant : aucun motif sensible en clair ne doit subsister dans le texte masqué.
"""

from __future__ import annotations

import time

import pytest

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


# ── Téléphone FR avec `(0)` de courtoisie ────────────────────────────────────
# `+33 (0)6 12 34 56 78` est LE format des signatures d'e-mail et des annuaires FR, donc
# massivement recopié dans les tickets. Il partait EN CLAIR au LLM : le préfixe matchait
# `+33` puis butait sur `(`, et l'ancrage interdisait toute reprise sur la suite du numéro
# — alors que les MÊMES chiffres sans `(0)` étaient masqués. Fuite d'autant plus trompeuse
# qu'un test « téléphone masqué » passait au vert sur le format sans `(0)`.
@pytest.mark.parametrize(
    "numero",
    [
        pytest.param("+33 (0)6 12 34 56 78", id="plus33-parenthese-zero"),
        pytest.param("0033 (0)6 12 34 56 78", id="0033-parenthese-zero"),
        pytest.param("+33 (0) 6 12 34 56 78", id="espace-apres-parenthese"),
        pytest.param("+33(0)612345678", id="colle"),
        pytest.param("+33.(0)6.12.34.56.78", id="points"),
        pytest.param("+33-(0)1-23-45-67-89", id="tirets"),
    ],
)
def test_masks_french_phone_with_courtesy_zero(numero):
    r = masking.mask(f"Cordialement, tel {numero} — service info")
    assert numero not in r.text
    assert masking.PHONE_PLACEHOLDER in r.text
    assert r.counts.get("phone") == 1


def test_courtesy_zero_phone_follows_toggle_and_stays_idempotent():
    texte = "tel +33 (0)6 12 34 56 78"
    assert masking.mask(texte, phone=False).text == texte  # toggle respecté
    once = masking.mask(texte).text
    assert masking.mask(once).text == once  # idempotent


def test_parenthese_zero_isolee_nest_pas_un_telephone():
    """Anti faux positif : `(0)` sans numéro derrière ne doit rien déclencher."""
    texte = "reste (0) article en stock, commande 2024"
    assert masking.mask(texte).text == texte


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


# ── Résistance au ReDoS (durcissement audit CodeQL 2026-08) ───────────────────
# Le texte masqué est le CONTENU D'UN TICKET, écrit par le demandeur : donnée non
# fiable. `mask()` étant appelé synchronement depuis une coroutine (services/triage),
# un motif à backtracking polynomial gelait l'event loop — donc l'API ET le poller —
# avec un seul ticket. Deux motifs étaient concernés (`_EMAIL_RE` et
# `_SECRET_KEYWORD_RE`) ; leurs quantificateurs sont désormais BORNÉS.
#
# On teste la PROPRIÉTÉ (croissance linéaire), pas un temps absolu : un seuil en
# millisecondes serait instable sur un runner CI chargé. Avant correctif, doubler
# l'entrée quadruplait le temps (×4) ; on exige ici un facteur nettement sous-quadratique.
@pytest.mark.parametrize(
    "charge",
    [
        pytest.param(lambda n: "password" + " " * n + "abc", id="secret-espaces"),
        pytest.param(lambda n: "1." * n + "!", id="longue-suite-sans-arobase"),
        pytest.param(lambda n: "a" * n + "!", id="longue-suite-de-mots"),
        # Charges TÉLÉPHONE : le motif a gagné un groupe optionnel `(0)`. Un optionnel mal
        # placé rouvrirait la porte au coût polynomial — ces deux charges le verrouillent.
        # `+33 (0)` répété = un préfixe qui amorce le motif à CHAQUE position mais n'aboutit
        # jamais ; la variante tronquée d'un chiffre force en plus le parcours des 4 groupes
        # de 2 chiffres avant l'échec (pire cas de la branche FR internationale).
        pytest.param(lambda n: "+33 (0)" * n, id="phone-prefixe-repete"),
        pytest.param(lambda n: "+33 (0)6 12 34 56 7 " * n, id="phone-tronque-repete"),
    ],
)
def test_masquage_reste_lineaire_sur_entree_pathologique(charge):
    """Budget ABSOLU, pas un ratio : c'est ce qui distingue vraiment linéaire de quadratique.

    Un ratio grand/petit sur une seule mesure est fragile — les temps en jeu sont de
    l'ordre de la milliseconde, et une pause GC ou une préemption de l'ordonnanceur sur
    un runner CI partagé suffit à le faire basculer, rougissant des PR sans rapport.
    On prend donc le MINIMUM de plusieurs répétitions (le minimum élimine le bruit :
    une exécution ne peut pas être plus rapide que le coût réel) et on le compare à un
    plafond large. Avant correctif, ces charges coûtaient de 0,4 s à 5,7 s ; après,
    elles sont sous les 10 ms. Un plafond à 500 ms ne peut donc être franchi que par un
    retour du comportement quadratique, jamais par du bruit de mesure.
    """

    def chrono_min(n: int, repetitions: int = 5) -> float:
        texte = charge(n)
        return min(
            (lambda d=time.perf_counter(): (masking.mask(texte), time.perf_counter() - d)[1])()
            for _ in range(repetitions)
        )

    ecoule = chrono_min(8_000)
    assert ecoule < 0.5, (
        f"masquage anormalement lent ({ecoule * 1000:.0f} ms pour 8 000 caractères) — "
        "un quantificateur non borné a probablement été réintroduit"
    )


def test_email_long_reste_masque_malgre_les_bornes():
    """Les bornes RFC (locale ≤ 64, label ≤ 63) ne doivent pas perdre d'adresse réelle."""
    locale = "prenom.nom.service-informatique.n1"
    adresse = f"{locale}@sous-domaine.exemple-client.co.uk"
    assert masking.mask(f"écrire à {adresse} svp").text == "écrire à [EMAIL] svp"


# ── Non-régression : le bornage anti-ReDoS ne doit pas créer de FUITE ─────────
# Le premier correctif ReDoS avait borné les blancs à 4/8 et la partie locale d'e-mail
# à 64 : des bornes « correctes » sur le papier, qui laissaient partir EN CLAIR au LLM
# un mot de passe collé depuis un formulaire aligné, ou une adresse à partie locale
# longue. Ces cas verrouillent l'arbitrage : résister au ReDoS ne justifie jamais de
# rater un masquage.
@pytest.mark.parametrize(
    "texte",
    [
        pytest.param("Mot de passe" + " " * 9 + ":" + " " * 9 + "Azerty1234", id="aligne-9-espaces"),
        pytest.param("Mot de passe" + " " * 30 + ": Azerty1234", id="aligne-30-espaces"),
        pytest.param("Mot     de     passe : Azerty1234", id="mots-espaces"),
        pytest.param("mot de passe: Azerty1234", id="sans-espace"),
    ],
)
def test_secret_masque_malgre_les_alignements(texte):
    assert "Azerty1234" not in masking.mask(texte).text


@pytest.mark.parametrize("longueur", [60, 70, 120, 250])
def test_email_masque_meme_partie_locale_longue(longueur):
    """> 64 caractères n'est pas conforme RFC, mais s'écrit très bien dans un ticket.

    L'ancrage `\\b` empêche toute reprise plus loin : si la borne est dépassée, l'adresse
    n'est pas masquée DU TOUT (et non partiellement) — d'où une fuite silencieuse.
    """
    adresse = "a" * longueur + "@exemple.fr"
    assert adresse not in masking.mask(f"contact {adresse} svp").text
