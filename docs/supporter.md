# Devenir Supporter (déverrouillage en place, sans rien perdre)

> Modèle open-core à **édition unique**. Voir aussi [`README.md`](../README.md#éditions-open-core).

## Le principe en une phrase

Le code des fonctionnalités **Supporter** est **déjà livré** dans l'image unique — il est
simplement **verrouillé**. Pour le déverrouiller, on **colle une clé de licence signée dans
la page Supporter** de la console ; rien d'autre ne change (même image, même `./data` : config
GLPI/LLM, périmètre, journal, `master.key`). Aucune migration, aucune perte. Réversible.

Pourquoi c'est sans risque :
- Toute la configuration vit dans `./data` (`itsm.db` chiffré + `master.key`) — jamais en image.
- Les features Supporter sont du **code déjà présent** (`src/itsm_modern_ai/features/`), pas de
  nouvelles tables → **schéma identique**, mêmes migrations.
- Un seul conteneur, une seule image (`itsm-modern-ai:latest`) : pas de swap d'image.

## Procédure (page Supporter)

1. Ouvrez la console (l'interface de l'application) et allez sur la page **Supporter**.
2. **Collez la clé de licence** (`itsm-lic.v1.…`) dans le champ prévu, puis validez.
3. La clé est **vérifiée hors-ligne** (signature Ed25519). Si elle est valide, les features
   passent immédiatement de *verrouillé* à *actif* — **en place**, sans redémarrage manuel.

C'est la seule méthode requise : tout se fait depuis la page Supporter de l'application.

> **Pré-amorçage optionnel (déploiements automatisés)** : pour livrer une instance déjà
> licenciée, vous pouvez définir `LICENSE_KEY=itsm-lic.v1.…` dans `.env` avant le premier
> démarrage. La page Supporter reste la méthode normale et recommandée.

## Revenir en Community (désactivation)

Sur la **même page Supporter**, **retirez la clé** (champ vidé / bouton de retrait) et validez.
Les fonctionnalités Supporter se **reverrouillent** immédiatement ; la donnée reste intacte
(retour à l'édition Community).

## Notes

- **Ne jamais** faire tourner deux conteneurs sur le même `./data` (SQLite mono-writer).
- **Air-gap / souveraineté** : tout est hors-ligne. La licence est vérifiée par signature
  Ed25519 embarquée — **aucun appel sortant**, aucun serveur de licence à joindre. La clé
  **privée** de signature reste dans le dépôt privé de signature des licences ; elle n'est
  jamais ici.
- **Sauvegarde** : comme pour toute mise à jour, sauvegardez `./data` avant (cf.
  [`docs/install.md`](install.md#mise-à-jour) / `./install.sh`).
