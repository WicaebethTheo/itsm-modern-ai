"""Vérification de licence Ed25519 hors-ligne (open-core).

Les jetons sont des FIXTURES pré-signées par la clé privée de l'éditeur (qui vit
uniquement dans le dépôt Enterprise privé) — on teste donc la VÉRIFICATION, pas la
signature, sans jamais exposer la clé privée dans le dépôt Community.
"""

from __future__ import annotations

from datetime import date

import pytest

from itsm_modern_ai.domain.licensing import (
    FEATURE_MULTI_ENTITY,
    FEATURE_PII_ADVANCED,
    FEATURE_SCHEDULED_EXPORTS,
    KNOWN_FEATURES,
    verify_license,
)

TODAY = date(2026, 5, 31)

# Licence enterprise valide (ACME DSI), 3 features, expire 2099-12-31.
VALID = (
    "itsm-lic.v1.eyJjdXN0b21lciI6IkFDTUUgRFNJIiwiZWRpdGlvbiI6ImVudGVycHJpc2UiLCJleHBpcmVz"
    "X2F0IjoiMjA5OS0xMi0zMSIsImZlYXR1cmVzIjpbInBpaV9hZHZhbmNlZCIsIm11bHRpX2VudGl0eSIsInNj"
    "aGVkdWxlZF9leHBvcnRzIl0sImlzc3VlZF9hdCI6IjIwMjYtMDEtMDEifQ.GulOzYrGtI1ihbx4hfVqHGNP"
    "m1AbmBrAQ169HvoEWt1HtlqPIFrgywO_JA4ZUR0t0tz7GJKc2F4CfdPK05wSAw"
)
# Licence expirée (2021-01-01).
EXPIRED = (
    "itsm-lic.v1.eyJjdXN0b21lciI6Ik9MRCBDb3JwIiwiZWRpdGlvbiI6ImVudGVycHJpc2UiLCJleHBpcmVz"
    "X2F0IjoiMjAyMS0wMS0wMSIsImZlYXR1cmVzIjpbIm11bHRpX2VudGl0eSJdLCJpc3N1ZWRfYXQiOiIyMDIw"
    "LTAxLTAxIn0.xkO10QjHcUXLYKp4qr6Q1JteoQk_shkvHeN_N2MJBqg3rzHwnvUok1A4omFvlrwbEaE1qDPI"
    "0KhtsS3O7q5lCQ"
)


def test_valid_license_unlocks_features():
    st = verify_license(VALID, today=TODAY)
    assert st.valid and st.is_enterprise
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
    # La fixture ne porte que des features connues ; on vérifie l'intersection avec le catalogue.
    st = verify_license(VALID, today=TODAY)
    assert st.features <= KNOWN_FEATURES
