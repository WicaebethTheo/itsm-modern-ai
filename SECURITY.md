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
- **Cookie de session `Secure`** : flag `https_only` piloté par `session_https_only` ; `SameSite=lax`. `false` = acceptable pour un **pilote en HTTP** sur réseau interne (posture livrée par défaut) ; `true` **obligatoire** dès que le service est derrière un TLS (le middleware ajoute alors aussi `Strict-Transport-Security`).
- **En-têtes de sécurité HTTP** sur toutes les réponses : `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` ; **CSP** sur le HTML de la SPA (`default-src 'self'`, `frame-ancestors 'none'`).

## Garde-fous applicatifs (durcissement audit 2026-05)

- **Anti-path-traversal (SPA)** : le service de fichiers statiques résout le chemin demandé et **exige qu'il reste sous `dist/`** ; toute tentative de sortie (`../`, `..%2f`) retombe sur l'index SPA — pas de lecture de `master.key`, `itsm.db` ni `.env`.
- **Anti-SSRF — validation lexicale** (écriture de config) : les URLs de base publiques (GLPI, Mistral, OpenAI, Anthropic) exigent `https://` et un hôte routable ; loopback / IP privée / metadata cloud sont **rejetés** (Ollama local toléré).
- **Anti-SSRF — garde runtime / anti DNS-rebinding** (`ssrf_guard_enabled`, défaut **`true`**) : avant chaque appel sortant (LLM, GLPI), l'hôte est **résolu** et toute IP interne est **bloquée** (fail-closed sur échec DNS) — donc **avant** toute fuite de token. Atténuation : une limite TOCTOU résiduelle (fenêtre entre la résolution DNS vérifiée et la connexion effective) est connue et assumée.
- **Masquage PII avant le LLM — selon la licence (open-core)** : sans licence, seuls **e-mail + téléphone** sont masqués ; le masquage **IBAN/cartes, secrets (mots de passe/tokens/clés API), IP/MAC, NIR/SIRET** est une feature **Supporter** (les regex custom sont en roadmap) (`FEATURE_PII_ADVANCED`) — son code est livré dans l'image mais reste verrouillé tant qu'aucune licence valide ne l'autorise. ⚠️ **Sans licence, IBAN et secrets sont transmis EN CLAIR au LLM et conservés en clair dans le journal `llm_calls`** — un bandeau l'indique dans la console (cf. la **console DPO** et [docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)).
- **Re-masquage des brouillons en modes auto** : avant toute publication **publique** (`semi_auto`/`full_auto`), le brouillon LLM est **re-masqué** (PII, selon la licence) et **borné en longueur**.
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

Merci de signaler toute vulnérabilité de manière **responsable et privée** — n'ouvrez
pas d'issue, de merge request ni de fil public pour une faille non corrigée.

**Contact** : **support@itsm-modern-ai.com** (l'alias relaie en privé au mainteneur).

Incluez de quoi reproduire : la version testée (tag `vX.Y.Z` ou SHA), l'endpoint/route
concerné, le comportement attendu vs constaté, et un PoC minimal si possible.

### Périmètre

En périmètre : le moteur de triage (polling GLPI, routage LLM, validation des décisions,
authentification/sessions, anti-SSRF, masquage PII, endpoints d'admin/export). Hors
périmètre : la **mauvaise configuration d'un déploiement** (TLS absent, port exposé, SSH
faible — responsabilité du déployeur) et les avis de dépendances **sans chemin de code
atteignable** (merci de joindre une preuve d'atteignabilité).

### Délais visés

Cibles (pas un engagement contractuel — projet à mainteneur unique) :

| Étape | Cible |
| --- | --- |
| Accusé de réception | sous 5 jours ouvrés |
| Triage initial (sévérité, repro) | sous 14 jours |
| Correctif ou mitigation documentée | sous 90 jours |
| Divulgation coordonnée après correctif | typiquement 7–30 jours |

Merci de laisser une fenêtre de divulgation raisonnable avant toute publication —
divulguer avant qu'un correctif soit disponible aggrave la situation des déployeurs.
