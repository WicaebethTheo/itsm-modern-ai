"""Vérification de licence Ed25519 hors-ligne (open-core).

Les jetons de test sont signés À LA VOLÉE avec une paire Ed25519 de TEST dédiée,
embarquée ci-dessous. Cette clé privée de test ne déverrouille RIEN : le produit
embarque une autre clé publique (celle de l'éditeur), et un fixture autouse
substitue la clé publique de test le temps du test.

⚠️ Ne JAMAIS committer ici un jeton signé par la clé privée de PRODUCTION : ce
dépôt est mirroré public. Le test `test_test_key_is_not_the_publisher_key`
verrouille cette propriété.
"""

from __future__ import annotations

import base64
import json
from datetime import date

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from itsm_modern_ai.domain import licensing
from itsm_modern_ai.domain.licensing import (
    FEATURE_MULTI_ENTITY,
    FEATURE_PII_ADVANCED,
    FEATURE_SCHEDULED_EXPORTS,
    KNOWN_FEATURES,
    verify_license,
)

TODAY = date(2026, 5, 31)

# ── Paire Ed25519 de TEST (dédiée aux tests, sans aucune valeur en dehors) ─────
# La clé privée peut vivre en clair ici : elle ne signe que des jetons vérifiés
# contre TEST_PUBLIC_KEY_HEX, jamais contre la clé publique embarquée du produit.
TEST_SIGNING_KEY_HEX = "6207e5305adef0b557a9e568dbefd1b97094a8bdb44996e6785591b6250f7c85"
TEST_PUBLIC_KEY_HEX = "c56015ecbbd074740f2adf93a6c0024336d329982853b7973d006fb8168d6bb6"

# Clé publique de production réellement embarquée, capturée à l'import (avant tout
# monkeypatch) pour pouvoir vérifier qu'elle diffère bien de la clé de test.
EMBEDDED_PUBLISHER_KEY_HEX = licensing.PUBLISHER_PUBLIC_KEY_HEX


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def sign_license(payload: dict) -> str:
    """Signe un payload de licence avec la clé de TEST (même format que l'outil éditeur)."""
    key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(TEST_SIGNING_KEY_HEX))
    payload_b64 = _b64u(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    signature = key.sign(f"v1.{payload_b64}".encode())
    return f"itsm-lic.v1.{payload_b64}.{_b64u(signature)}"


def make_license(
    *,
    customer: str = "ACME DSI",
    edition: str = "supporter",
    features: tuple[str, ...] = (FEATURE_PII_ADVANCED, FEATURE_MULTI_ENTITY, FEATURE_SCHEDULED_EXPORTS),
    issued_at: str = "2026-01-01",
    expires_at: str = "2099-12-31",
) -> str:
    return sign_license(
        {
            "customer": customer,
            "edition": edition,
            "features": list(features),
            "issued_at": issued_at,
            "expires_at": expires_at,
        }
    )


# Mêmes cas de figure que les anciennes fixtures pré-signées, régénérés à chaque run.
VALID = make_license()
EXPIRED = make_license(
    customer="OLD Corp",
    features=(FEATURE_MULTI_ENTITY,),
    issued_at="2020-01-01",
    expires_at="2021-01-01",
)


@pytest.fixture(autouse=True)
def _use_test_publisher_key(monkeypatch):
    """Substitue la clé publique de TEST — `_public_key()` la lit à chaque appel."""
    monkeypatch.setattr(licensing, "PUBLISHER_PUBLIC_KEY_HEX", TEST_PUBLIC_KEY_HEX)


def test_test_key_is_not_the_publisher_key(monkeypatch):
    # Garde anti-régression : la clé de test ne doit jamais devenir la clé embarquée,
    # et un jeton signé par la clé de test ne doit rien déverrouiller en prod.
    assert TEST_PUBLIC_KEY_HEX != EMBEDDED_PUBLISHER_KEY_HEX
    monkeypatch.setattr(licensing, "PUBLISHER_PUBLIC_KEY_HEX", EMBEDDED_PUBLISHER_KEY_HEX)
    st = verify_license(VALID, today=TODAY)
    assert not st.valid and st.error == "signature invalide"


def test_valid_license_unlocks_features():
    st = verify_license(VALID, today=TODAY)
    assert st.valid and st.is_supporter
    assert st.customer == "ACME DSI"
    assert st.features == {FEATURE_PII_ADVANCED, FEATURE_MULTI_ENTITY, FEATURE_SCHEDULED_EXPORTS}
    assert st.has_feature(FEATURE_MULTI_ENTITY)
    assert st.error is None


def test_empty_token_is_community():
    st = verify_license("", today=TODAY)
    assert not st.valid and st.edition == "community"
    assert st.features == frozenset()


def test_expired_license_is_rejected():
    st = verify_license(EXPIRED, today=TODAY)
    assert not st.valid and st.edition == "community"
    assert st.error == "licence expirée"
    assert not st.has_feature(FEATURE_MULTI_ENTITY)


def test_expired_license_was_valid_before_expiry():
    st = verify_license(EXPIRED, today=date(2020, 6, 1))
    assert st.valid and st.has_feature(FEATURE_MULTI_ENTITY)


def test_tampered_payload_fails_signature():
    # On modifie un caractère de la charge utile → signature invalide.
    parts = VALID.split(".")
    parts[2] = parts[2][:-2] + ("AA" if not parts[2].endswith("AA") else "BB")
    tampered = ".".join(parts)
    st = verify_license(tampered, today=TODAY)
    assert not st.valid
    assert st.error in {"signature invalide", "charge utile illisible", "jeton illisible"}


def test_garbage_token_is_rejected():
    st = verify_license("n'importe.quoi", today=TODAY)
    assert not st.valid and st.error == "format de jeton invalide"


@pytest.mark.parametrize("bad", ["itsm-lic.v2.x.y", "other.v1.x.y", "itsm-lic.v1.only-three"])
def test_bad_prefixes_rejected(bad):
    assert not verify_license(bad, today=TODAY).valid


def test_unknown_features_are_filtered_out():
    # Une feature inconnue portée par le jeton est filtrée par intersection avec le catalogue.
    token = sign_license(
        {
            "customer": "ACME DSI",
            "edition": "supporter",
            "features": [FEATURE_PII_ADVANCED, "feature_inconnue"],
            "issued_at": "2026-01-01",
            "expires_at": "2099-12-31",
        }
    )
    st = verify_license(token, today=TODAY)
    assert st.valid
    assert st.features == {FEATURE_PII_ADVANCED}
    assert st.features <= KNOWN_FEATURES
