# Politique de sécurité — ITSM Modern AI (pilote V1)

## Posture

Déploiement **pilote** prévu pour un **réseau interne non exposé**. La base de référence sécurité est dimensionnée pour ce contexte et **doit être durcie avant tout déploiement payant** (PRD §12). Ce document décrit l'état du pilote, pas une cible de production.

## Secrets

- La **clé API LLM** et les **tokens GLPI** se poussent via l'API/UI de configuration (`POST /api/config`), jamais via `.env`.
- Ils sont **chiffrés au repos** avec **Fernet** (bibliothèque `cryptography`), FR-25.
- La **master key** de chiffrement provient de `data/master.key` ou de la variable d'environnement `MASTER_KEY`.
- **Aucun secret en clair** : ni en base de données, ni dans `.env`, ni dans les logs.

## Authentification

- **Authentification locale** pour les fonctions d'administration et d'export (FR-24).
- Mot de passe administrateur, haché avec **Argon2** ; gestion par session.
- **2FA TOTP** : codé mais **désactivé par défaut** (réseau interne non exposé).

## Transport

- **HTTPS via reverse proxy** (nginx, Caddy, …) devant le service (FR-26). La terminaison TLS est déléguée au proxy ; le HTTP nu doit être redirigé ou refusé au niveau du proxy.

## Souveraineté

- **Aucun phone-home.**
- **Aucun appel sortant** hors du fournisseur LLM configuré (Mistral EU par défaut).
- Application 100 % on-premise sur l'infrastructure du client.

## Signaler une vulnérabilité

Merci de signaler toute vulnérabilité de manière responsable et privée au mainteneur :

- Contact : `security@example.com` *(placeholder — à remplacer par l'adresse réelle du mainteneur)*

Merci de ne pas divulguer publiquement une faille avant qu'un correctif soit disponible.
