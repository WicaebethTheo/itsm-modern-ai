# Modes d'exécution

> Trois modes, réglables **par entité GLPI** dans la console (page Périmètre → `PUT /api/modes`). Défaut global sûr : `suggestion`.

| Mode | Mutation GLPI | Suivi | Réponse au demandeur | Quand l'utiliser |
|---|:---:|:---:|:---:|---|
| **`suggestion`** | aucune | **privé** (technicien seulement) | jamais | Démarrage, calibration, périmètres sensibles. |
| **`semi_auto`** | si confiance ≥ 2ᵉ seuil strict (défaut 0,9) | **public** si appliqué, privé sinon | si appliqué | Périmètres rodés, montée en confiance progressive. |
| **`full_auto`** | toujours (catégorie, urgence + priorité, assignation) | **public** | toujours | Catégories simples et bien outillées (mots de passe oubliés, etc.). |

Tous les modes appliquent **le même garde-fou** en amont (masquage, whitelist, seuil, fallback « à trier »). Les seuls effets variables sont la mutation et la visibilité du Suivi.

## Invariants absolus, tous modes confondus

- **Garde-fou déterministe** (whitelist + seuil) en amont — l'IA ne décide jamais seule.
- **Fallback unique « à trier »** — toute erreur, tout doute, tout dépassement de cap retombe ici.
- **Mutation via la seule porte `ItsmPort.apply_decision`** — `PUT Ticket` + acteurs en update, jamais de bypass.

## Conséquence sur le brouillon

En mode `suggestion`, le brouillon est **jamais envoyé** au demandeur (Suivi privé). En `semi_auto`/`full_auto`, lorsque la Décision est appliquée, le brouillon est posté en **Suivi public** — c'est la réponse au demandeur. Cette bascule est un choix explicite de l'opérateur par entité (avec bandeau d'avertissement dans l'UI).

## Voir aussi

- [`docs/architecture.md`](architecture.md) — pipeline immuable.
- [`docs/project-context.md`](project-context.md) — invariants non-négociables.
