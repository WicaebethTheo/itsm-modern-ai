# Devenir Supporter (déverrouillage en place, sans rien perdre)

> Modèle open-core à **édition unique**. Voir aussi [`README.md`](../README.md#éditions-open-core).

## Le principe en une phrase

Le code des fonctionnalités **Supporter** est **déjà livré** dans l'image unique — il est
simplement **verrouillé**. Pour le déverrouiller, on **colle une clé de licence signée dans
la page Supporter** de la console ; rien d'autre ne change — même image, même base, même
`master.key` (config GLPI/LLM, périmètre, journal restent en place). Aucune migration, aucune
perte. Réversible.

Pourquoi c'est sans risque :
- **Rien de tout cela ne vit dans l'image.** La configuration (y compris les secrets chiffrés
  Fernet), le périmètre et le journal vivent dans la **base PostgreSQL** ; la `master.key` qui les
  déchiffre vit dans le volume applicatif `itsm_data` (`/app/data`). Changer d'édition ne touche
  ni l'une ni l'autre.
- Les features Supporter sont du **code déjà présent** (`src/itsm_modern_ai/features/`), pas de
  nouvelles tables → **schéma identique**, mêmes migrations.
- Une seule image du moteur (`itsm-modern-ai:latest`, ou celle de GHCR) : pas de swap d'image.
  La stack compte bien **deux services** (moteur + base), mais le service `postgres` n'est
  concerné en rien par le passage en Supporter.

## Procédure (page Supporter)

1. Ouvrez la console (l'interface de l'application) et allez sur la page **Supporter**.
2. **Collez la clé de licence** (`itsm-lic.v1.…`) dans le champ prévu, puis validez.
3. La clé est **vérifiée hors-ligne** (signature Ed25519). Si elle est valide, les features
   passent immédiatement de *verrouillé* à *actif* — **en place**, sans redémarrage manuel.

> **Ce qu'une licence valide déverrouille RÉELLEMENT aujourd'hui.** Sur les trois modules du
> catalogue, seul `pii_advanced` a une surface d'usage : `multi_entity` et
> `scheduled_exports` sont annoncés sur la feuille de route et la page Supporter les affiche
> désormais **« Prévu »**, jamais « Débloqué », même quand une licence les autorise. Peindre
> une promesse en réussite parce que le porteur a payé est précisément ce qu'on refuse de
> faire. Le triplet exposé par `GET /api/license` reste `installed` (le code est présent —
> toujours vrai, l'édition est unique) ∧ `entitled` (la licence l'autorise) = `active`, avec
> `coming_soon` en quatrième champ pour distinguer « autorisé » de « utilisable ».

C'est la seule méthode requise : tout se fait depuis la page Supporter de l'application.

> **Pré-amorçage optionnel (déploiements automatisés)** : pour livrer une instance déjà
> licenciée, vous pouvez définir `LICENSE_KEY=itsm-lic.v1.…` dans `.env` avant le premier
> démarrage. La page Supporter reste la méthode normale et recommandée.

> **Compte admin** : il se crée **à la première visite** de la console (email + mot de passe),
> pas via une variable d'environnement — rien à faire ici pour devenir Supporter, sinon être
> connecté (la page Supporter est une page d'administration). Changement de mot de passe :
> page **Compte & sécurité**, menu de compte en haut à droite. Mot de passe **oublié** (plus de
> session du tout) : `docker compose exec itsm python -m itsm_modern_ai.admin_setup --force`.

## Revenir en Community (désactivation)

Sur la **même page Supporter** (section *Avancé* du menu), retirez la clé avec le bouton
**« Réinitialiser »**. Il est présent dans les deux états de la page : sous la licence active,
à côté de « Renouveler / remplacer la clé » ; et sur l'écran de saisie, à côté d'« Activer »,
dès qu'une clé est stockée — y compris une clé valide qui n'autorise rien.
Les fonctionnalités Supporter se **reverrouillent** immédiatement ; la donnée reste intacte
(retour à l'édition Community).

## Notes

- **Ne pas** faire tourner deux moteurs sur la même base. La raison n'est plus le mono-writer
  SQLite (PostgreSQL encaisse les écritures concurrentes) : c'est que le pilote est **mono-process**
  — le rate-limit du login est en mémoire (pas de store partagé, donc contournable en tournant à
  plusieurs) et deux planificateurs se disputeraient les cycles de poll.
- **Air-gap / souveraineté** : *la vérification de licence* est hors-ligne — pas la totalité
  du produit. Le vérificateur de version interroge GitHub par défaut (le couper : `UPDATE_CHECK_URL=`
  vide), et le fournisseur LLM est appelé sauf en Ollama local. La licence est vérifiée par signature
  Ed25519 embarquée — **aucun appel sortant**, aucun serveur de licence à joindre. La clé
  **privée** de signature reste dans le dépôt privé de signature des licences ; elle n'est
  jamais ici.
- **Sauvegarde** : comme avant toute mise à jour, prenez une sauvegarde — pas une copie de
  fichiers, la commande livrée, qui prend le dump de la base **et** la `master.key` et vérifie ce
  qu'elle a écrit :
  ```bash
  docker compose exec itsm python -m itsm_modern_ai.backup
  ```
  (cf. [`docs/install.md`](install.md#sauvegarde-et-restauration)).
