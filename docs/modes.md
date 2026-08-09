# Modes d'exécution

> Trois modes, réglables **par entité GLPI** dans la console (page Périmètre → `PUT /api/modes`). Défaut global sûr : `suggestion`.

| Mode | Mutation GLPI | Suivi | Réponse au demandeur | Quand l'utiliser |
|---|:---:|:---:|:---:|---|
| **`suggestion`** | aucune | **privé** (technicien seulement) | jamais | Démarrage, calibration, périmètres sensibles. |
| **`semi_auto`** | si confiance ≥ 2ᵉ seuil strict (défaut 0,9) | **public** si appliqué, privé sinon | si appliqué | Périmètres rodés, montée en confiance progressive. |
| **`full_auto`** | toujours (catégorie, urgence + priorité, assignation) | **public** | toujours | Catégories simples et bien outillées (mots de passe oubliés, etc.). |

Tous les modes appliquent **le même garde-fou** en amont (masquage, whitelist, seuil, fallback « à trier »). Les seuls effets variables sont la mutation et la visibilité du Suivi.

## « à trier » : ce que le Ticket reçoit (depuis 0.9.50)

Un Ticket qui part « à trier » n'est **jamais muté** — mais il ne repart plus les mains vides. Deux familles, à ne pas confondre :

| Situation | Motifs | Ce que GLPI reçoit | Ticket rejoué ? |
|---|---|---|:---:|
| **Refus arbitré** — l'IA a répondu, le code a dit non | `low_confidence`, `no_eligible_assignee`, `*_not_in_whitelist` | **Suivi PRIVÉ « non tranché »** : motif du refus + valeurs envisagées, étiquetées « hors périmètre » le cas échéant. **Aucun champ écrit, aucun brouillon.** | non — consommé |
| **Triage pas eu lieu** | `llm_error`, `invalid_output`, `cost_cap_reached` | **rien** — y écrire produirait une annotation par cycle sur une panne passagère, puis un doublon au rejeu | **oui** |

Ce Suivi vaut dans les **trois** modes, `suggestion` compris : il n'applique rien. Sans lui, un Ticket refusé restait « Nouveau » dans GLPI, indistinguable d'un Ticket que personne n'a ouvert — mesuré en lab : 7 Tickets sur 20 sur une instance en `full_auto`.

## Invariants absolus, tous modes confondus

- **Garde-fou déterministe** (whitelist + seuil) en amont — l'IA ne décide jamais seule.
- **Fallback unique « à trier »** — toute erreur, tout doute, tout dépassement de cap retombe ici. Le Suivi « non tranché » est une **action prise sur l'échappatoire**, en aval : le moteur garde une sortie unique.
- **Mutation via la seule porte `ItsmPort.apply_decision`** — `PUT Ticket` + acteurs en update, jamais de bypass. `write_followup` n'écrit aucun champ et n'est pas une mutation.

## Conséquence sur le brouillon

En mode `suggestion`, le brouillon est **jamais envoyé** au demandeur (Suivi privé). En `semi_auto`/`full_auto`, lorsque la Décision est appliquée, le brouillon est posté en **Suivi public** — c'est la réponse au demandeur. Cette bascule est un choix explicite de l'opérateur par entité (avec bandeau d'avertissement dans l'UI).

## Voir aussi

- [`docs/architecture.md`](architecture.md) — pipeline immuable.
- [`docs/project-context.md`](project-context.md) — invariants non-négociables.
