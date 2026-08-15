"""Validation de l'adresse administrateur : ce qu'elle accepte, et ce qu'elle coûte.

Cette adresse n'est pas un canal d'envoi — le produit ne parle à aucun SMTP — c'est
l'IDENTIFIANT de connexion du compte unique. Le motif reste donc volontairement permissif :
il refuse ce qui ne peut pas être un identifiant, pas ce qui déplairait à la RFC 5322.

Le second bloc garde le COÛT du motif. Une expression où le point appartient aux deux côtés
du séparateur oblige le moteur, sur une saisie qui ne correspond pas, à essayer chaque
découpage possible — quadratique en la longueur de la saisie.
"""

from __future__ import annotations

import time

import pytest

from itsm_modern_ai.api.security import _EMAIL_RE, EMAIL_MAX_CHARS, email_is_valid


@pytest.mark.parametrize(
    "adresse",
    [
        "admin@exemple.fr",
        "a@b.co",
        "prenom.nom+etiquette@sous.domaine.exemple.fr",
        "utilisateur_1@intra-net.local",
    ],
)
def test_les_adresses_utilisables_passent(adresse: str) -> None:
    assert email_is_valid(adresse)


@pytest.mark.parametrize(
    "adresse",
    [
        "",
        "admin",  # pas d'arobase
        "admin@exemple",  # pas de point : aucun domaine joignable
        "admin exemple@fr.fr",  # espace
        "@exemple.fr",  # partie locale vide
        "admin@.fr",  # étiquette vide
        "admin@exemple.",  # point final
        "admin@exemple..fr",  # étiquette vide au milieu
        "a@b@c.fr",  # deux arobases
    ],
)
def test_ce_qui_ne_peut_pas_etre_un_identifiant_est_refuse(adresse: str) -> None:
    assert not email_is_valid(adresse)


def test_la_longueur_est_bornee() -> None:
    """RFC 5321 : 254 caractères. Une adresse plus longue ne vient pas d'un humain."""
    trop_long = "a" * EMAIL_MAX_CHARS + "@exemple.fr"
    assert not email_is_valid(trop_long)
    assert email_is_valid("a" * (EMAIL_MAX_CHARS - len("@exemple.fr")) + "@exemple.fr")


def test_le_motif_ne_deraille_pas_sur_une_saisie_hostile() -> None:
    """Le motif est éprouvé SANS la borne de longueur, donc sur son seul mérite.

    `email_is_valid` refuse au-delà de 254 caractères avant même de lancer le moteur : sur
    ce chemin-là, la version quadratique n'était pas exploitable. Mais une borne ne rend pas
    un motif sain, elle rend son défaut non rentable — et rien ne garantit que le prochain
    appelant du motif la posera aussi. On mesure donc `_EMAIL_RE` directement.

    Ordre de grandeur : sur cette entrée, la forme `[^\\s@]+\\.[^\\s@]+` mettait ~2,5 s ;
    la forme à classes disjointes, ~2 ms. Le seuil est large exprès — il attrape un retour
    au quadratique, il ne mesure pas la machine.
    """
    hostile = "!@" + "!." * 20_000 + " "  # l'espace final interdit toute correspondance
    debut = time.perf_counter()
    resultat = _EMAIL_RE.match(hostile)
    ecoule = time.perf_counter() - debut

    assert resultat is None
    assert ecoule < 0.5, f"motif quadratique : {ecoule:.2f} s sur une saisie de refus"
