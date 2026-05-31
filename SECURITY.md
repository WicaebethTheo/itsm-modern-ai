# Politique de sécurité — ITSM Modern AI (pilote V1)

## Posture

Déploiement **pilote** prévu pour un **réseau interne non exposé**. La base de référence sécurité est dimensionnée pour ce contexte et **doit être durcie avant tout déploiement payant** (PRD §12). Ce document décrit l'état du pilote, pas une cible de production.

## Secrets

- La **clé API du fournisseur LLM** (**Mistral EU**, **OpenAI** ou **Anthropic** ; **Ollama** étant local n'utilise **aucune clé**) et les **tokens GLPI** se poussent via l'API/UI de configuration (`POST /api/config`), jamais via `.env`.
- Ils sont **chiffrés au repos** avec **Fernet** (bibliothèque `cryptography`), FR-25.
- La **master key** de chiffrement provient de `data/master.key` ou de la variable d'environnement `MASTER_KEY`.
- **Aucun secret en clair** : ni en base de données, ni dans `.env`, ni dans les logs.
- **Séparation des usages de clé (durcissement audit 2026-05)** : la clé Fernet ne sert **plus** aussi de secret de signature des sessions. Le secret de session est **dérivé** par **HKDF-SHA256** (`derive_key(info=b"session-signing")`) — clé **distincte** et **stable** entre redémarrages.
- **Décryptage fail-safe** : un secret illisible (MASTER_KEY incohérente / token corrompu) lève une erreur **métier** (`SecretDecryptError`) au lieu d'un HTTP 500 — évite de verrouiller l'admin derrière une erreur serveur opaque ; le secret est à reconfigurer.

## Authentification

- **Authentification locale** pour les fonctions d'administration et d'export (FR-24).
- Mot de passe administrateur, haché avec **Argon2** ; gestion par session.
- **Fail-closed (durcissement audit 2026-05)** : si **aucun** mot de passe admin n'est configuré, les endpoints d'admin sont **refusés (401)** par défaut. L'ancien comportement « ouvert » (pilote réseau interne) doit être activé **explicitement** via le réglage `dev_open_admin=true` — réservé au dev/labo, **jamais en prod**.
- **Rate-limit du login** (anti brute-force) **en mémoire** par IP (mono-process pilote, pas de store partagé / pas de HA). Honore `X-Forwarded-For` si `trust_proxy_headers=true`.
- **2FA TOTP** : codé mais **désactivé par défaut** (réseau interne non exposé).

## Transport

- **HTTPS via reverse proxy** (nginx, Caddy, …) devant le service (FR-26). La terminaison TLS est déléguée au proxy ; le HTTP nu doit être redirigé ou refusé au niveau du proxy.
- **Cookie de session `Secure`** : flag `https_only` piloté par `session_https_only` (défaut **`true`**, prod derrière TLS) ; `SameSite=lax`. À passer à `false` **uniquement** pour du dev/test en HTTP local.

## Garde-fous applicatifs (durcissement audit 2026-05)

- **Anti-path-traversal (SPA)** : le service de fichiers statiques résout le chemin demandé et **exige qu'il reste sous `dist/`** ; toute tentative de sortie (`../`, `..%2f`) retombe sur l'index SPA — pas de lecture de `master.key`, `itsm.db` ni `.env`.
- **Anti-SSRF — validation lexicale** (écriture de config) : les URLs de base publiques (GLPI, Mistral, OpenAI, Anthropic) exigent `https://` et un hôte routable ; loopback / IP privée / metadata cloud sont **rejetés** (Ollama local toléré).
- **Anti-SSRF — garde runtime / anti DNS-rebinding** (`ssrf_guard_enabled`, défaut **`true`**) : avant chaque appel sortant (LLM, GLPI), l'hôte est **résolu** et toute IP interne est **bloquée** (fail-closed sur échec DNS) — donc **avant** toute fuite de token. Atténuation (voir [`docs/audit-2026-05.md`](docs/audit-2026-05.md) §6 pour la limite TOCTOU résiduelle).
- **Masquage PII avant le LLM — selon l'édition (open-core)** : en **Community**, seuls **e-mail + téléphone** sont masqués ; le masquage **IBAN/cartes, secrets (mots de passe/tokens/clés API), IP/MAC, NIR/SIRET + regex custom** est une feature **Enterprise** (`FEATURE_PII_ADVANCED`). ⚠️ **En Community, IBAN et secrets sont transmis EN CLAIR au LLM et conservés en clair dans le journal `llm_calls`** — un bandeau l'indique dans la console (cf. [`docs/dpo.md`](docs/dpo.md)).
- **Re-masquage des brouillons en modes auto** : avant toute publication **publique** (`semi_auto`/`full_auto`), le brouillon LLM est **re-masqué** (PII, selon l'édition) et **borné en longueur**.
- **Bornes de génération LLM** (`max_tokens`) : plafonne coût/latence (consommation non bornée, OWASP LLM10).
- **Neutralisation de l'injection de formule CSV** : les cellules d'export DPO commençant par `= + - @ \t \r` sont préfixées d'une apostrophe (protège tableurs).

## Observabilité

- **Logging structuré** : `log_level` + `log_format` (`text`|`json`). Le format JSON **n'inclut aucune PII** (pas de corps de requête ni de query string).
- **Métriques Prometheus** : `GET /metrics` (hors `/api`) — volumétrie + latence par route **templatée** (pas de PII dans les labels). Désactivable (`metrics_enabled`) et **protégeable** par un jeton de scrape (`metrics_token` → `Authorization: Bearer …` ou `X-Metrics-Token`, comparaison à temps constant).

## Souveraineté

- **Aucun phone-home.**
- **Aucun appel sortant** hors du fournisseur LLM configuré (Mistral EU par défaut ; **Ollama** ne sort pas du tout, modèle local).
- Application 100 % on-premise sur l'infrastructure du client.
- **Périmètre d'action restreint par sélection admin** : l'IA n'agit que sur les **catégories, techniciens, groupes et entités** explicitement autorisés par l'admin (Whitelist curée depuis un scan GLPI). Tout ID hors de ce périmètre effectif est rejeté → Ticket « à trier », aucune écriture (FR-7).

## Signaler une vulnérabilité

Merci de signaler toute vulnérabilité de manière responsable et privée au mainteneur :

- Contact : `security@example.com` *(placeholder — à remplacer par l'adresse réelle du mainteneur)*

Merci de ne pas divulguer publiquement une faille avant qu'un correctif soit disponible.
