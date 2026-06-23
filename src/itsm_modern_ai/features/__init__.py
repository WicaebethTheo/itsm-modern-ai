"""Implémentations des features Supporter — intégrées à l'image unique, gatées par licence.

Ces modules sont livrés dans le code Community mais restent **verrouillés** tant qu'une
licence Supporter valide n'est pas collée (cf. `domain.licensing` + `feature_guard`). Le
registre enregistre leur implémentation (`installed`) ; la licence en autorise l'usage
(`entitled`) ; `active = installed ∧ entitled`.
"""

from __future__ import annotations


def register(registry) -> None:
    from . import multi_entity, pii_advanced, scheduled_exports

    pii_advanced.register(registry)
    multi_entity.register(registry)
    scheduled_exports.register(registry)
