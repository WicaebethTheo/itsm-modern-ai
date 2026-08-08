# Politique de sécurité — ITSM Modern AI (pilote V1)

## Posture

Déploiement **pilote** prévu pour un **réseau interne non exposé**. La base de référence sécurité est dimensionnée pour ce contexte et **doit être durcie avant tout déploiement payant** (PRD §12). Ce document décrit l'état du pilote, pas une cible de production.

## Secrets

- La **clé API du fournisseur LLM** (**Mistral EU**, **OpenAI** ou **Anthropic** ; **Ollama** étant local n'utilise **aucune clé**) et les **tokens GLPI** se poussent via l'API/UI de configuration (`POST /api/config`), jamais via `.env`.
- Ils sont **chiffrés au repos** avec **Fernet** (bibliothèque `cryptography`), FR-25.
- La **master key** de chiffrement provient de `data/master.key` ou de la variable d'environnement `MASTER_KEY`.
- **Aucun secret APPLICATIF en clair** (clés LLM, tokens GLPI) : ni en base, ni dans `.env`, ni dans les logs.
  ⚠️ En revanche, `.env` porte **par conception** deux éléments sensibles : la **`MASTER_KEY`** — celle qui déchiffre tous les autres secrets — et le **mot de passe d'amorçage** (`ITSM_ADMIN_PASSWORD`). `data/master.key` est également en clair sur disque (mode `0600`). Ces fichiers doivent être protégés en conséquence : ce sont eux qui donnent accès au reste.
- **Séparation des usages de clé (durcissement audit 2026-05)** : la clé Fernet ne sert **plus** aussi de secret de signature des sessions. Le secret de session est **dérivé** par **HKDF-SHA256** (`derive_key(info=b"session-signing")`) — clé **distincte** et **stable** entre redémarrages.
- **Décryptage fail-safe** : un secret illisible (MASTER_KEY incohérente / token corrompu) lève une erreur **métier** (`SecretDecryptError`) au lieu d'un HTTP 500 — évite de verrouiller l'admin derrière une erreur serveur opaque ; le secret est à reconfigurer.

## Authentification

- **Authentification locale** pour les fonctions d'administration et d'export (FR-24).
- Mot de passe administrateur, haché avec **Argon2** ; gestion par session.
- **Fail-closed (durcissement audit 2026-05)** : si **aucun** mot de passe admin n'est configuré, les endpoints d'admin sont **refusés (401)** par défaut. L'ancien comportement « ouvert » (pilote réseau interne) doit être activé **explicitement** via le réglage `dev_open_admin=true` — réservé au dev/labo, **jamais en prod**.
- **Révocation de session** : le cookie porte une **génération** de session, revérifiée à chaque requête. Le logout ET tout changement de mot de passe admin l'incrémentent — une session volée cesse donc d'être valable, sans store partagé. (Auparavant, la seule parade était de changer `MASTER_KEY`, ce qui rendait illisibles tous les secrets et verrouillait la console.)
- **Journal d'audit des actions d'administration** (`audit_log`) : toute écriture de configuration est tracée (acteur = IP, action, clé, ancienne → nouvelle valeur), secrets remplacés par `***`. Inclut le passage d'une **entité** en `semi_auto`/`full_auto`, qui autorise l'IA à muter des Tickets et à répondre publiquement. Table **exclue de la purge RGPD** : la purger sur la fenêtre « tickets » offrirait un effacement de traces trivial. ⚠️ `actor` porte une IP — une fenêtre de conservation dédiée reste à décider explicitement.
- **Rate-limit du login** (anti brute-force) **en mémoire** par IP (mono-process pilote, pas de store partagé / pas de HA). Honore `X-Forwarded-For` si `trust_proxy_headers=true`.
- **2FA TOTP : en alpha** — **non implémentée à ce jour** dans le produit. À ne **pas** considérer comme un contrôle disponible, ni la présenter comme telle en audit.

## Transport

- **HTTPS via reverse proxy** (nginx, Caddy, …) devant le service (FR-26). La terminaison TLS est déléguée au proxy ; le HTTP nu doit être redirigé ou refusé au niveau du proxy.
- **Cookie de session `Secure`** : flag `https_only` piloté par `session_https_only` ; `SameSite=lax`. `false` = acceptable pour un **pilote en HTTP** sur réseau interne (posture livrée par défaut) ; `true` **obligatoire** dès que le service est derrière un TLS (le middleware ajoute alors aussi `Strict-Transport-Security`).
- **En-têtes de sécurité HTTP** sur toutes les réponses : `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` ; **CSP** sur le HTML de la SPA (`default-src 'self'`, `frame-ancestors 'none'`).

## Garde-fous applicatifs (durcissement audit 2026-05)

- **Anti-path-traversal (SPA)** : le service de fichiers statiques résout le chemin demandé et **exige qu'il reste sous `dist/`** ; toute tentative de sortie (`../`, `..%2f`) retombe sur l'index SPA — pas de lecture de `master.key`, `itsm.db` ni `.env`.
- **Anti-SSRF — validation lexicale** (écriture de config) : les URLs de base publiques (GLPI, Mistral, OpenAI, Anthropic) exigent `https://` et un hôte routable ; loopback / IP privée / metadata cloud sont **rejetés** (Ollama local toléré).
- **Anti-SSRF — garde runtime / anti DNS-rebinding** (`ssrf_guard_enabled`, défaut **`true`**) : avant chaque appel sortant (LLM, GLPI), l'hôte est **résolu** et toute IP interne est **bloquée** (fail-closed sur échec DNS) — donc **avant** toute fuite de token. Atténuation : une limite TOCTOU résiduelle (fenêtre entre la résolution DNS vérifiée et la connexion effective) est connue et assumée.
  ⚠️ **Exception livrée par défaut** : `glpi_allow_private_host=true` (alias `GLPI_ALLOW_PRIVATE`) désactive ce garde **pour les seuls connecteurs GLPI** — sans quoi le produit ne pourrait pas atteindre un GLPI on-premise, qui vit presque toujours sur une IP privée ou un nom `.local`. Autrement dit, la phrase ci-dessus est vraie pour le **LLM** et le **vérificateur de version** en toute circonstance, et pour **GLPI seulement si ce flag est repassé à `false`**. Le compromis est explicite, pas accidentel — mais il doit être connu avant d'affirmer que « toute IP interne est bloquée ».
- **Masquage PII avant le LLM — selon la licence (open-core)** : sans licence, seuls **e-mail + téléphone** sont masqués ; le masquage **IBAN/cartes, secrets (mots de passe/tokens/clés API), IP/MAC, NIR/SIRET** est une feature **Supporter** (les regex custom sont en roadmap) (`FEATURE_PII_ADVANCED`) — son code est livré dans l'image mais reste verrouillé tant qu'aucune licence valide ne l'autorise. ⚠️ **Sans licence, IBAN et secrets sont transmis EN CLAIR au LLM et conservés en clair dans le journal `llm_calls`** — un bandeau l'indique dans la console (cf. la **console DPO** et [docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)).
- **Re-masquage des brouillons en modes auto** : avant toute publication **publique** (`semi_auto`/`full_auto`), le brouillon LLM est **re-masqué** (PII, selon la licence) et **borné en longueur**.
- **Bornes de génération LLM** (`max_tokens`) : plafonne coût/latence (consommation non bornée, OWASP LLM10).
- **Neutralisation de l'injection de formule CSV** : les cellules d'export DPO commençant par `= + - @ \t \r` sont préfixées d'une apostrophe (protège tableurs).
- **Fenêtre d'idempotence (risque résiduel assumé)** : le poller marque un Ticket `processed` **après** l'action. Un arrêt brutal entre la mutation GLPI et ce marquage peut, au cycle suivant, produire une **seconde mutation et une seconde réponse publique** — **en modes `semi_auto`/`full_auto` uniquement**. En mode `suggestion` (défaut) l'impact est nul : au pire un Suivi **privé** en double. Fenêtre connue et assumée (pas de transaction distribuée avec GLPI).

## Observabilité

- **Logging structuré** : `log_level` + `log_format` (`text`|`json`). Le format JSON **n'inclut aucune PII** (pas de corps de requête ni de query string).
- **Métriques Prometheus** : `GET /metrics` (hors `/api`) — volumétrie + latence par route **templatée** (pas de PII dans les labels). Désactivable (`metrics_enabled`). **Depuis la 0.9.48, l'endpoint n'est plus anonyme par défaut** : sans `metrics_token` configuré, il exige une **session administrateur** ; avec un jeton, le scrape machine reste anonyme (`Authorization: Bearer …` ou `X-Metrics-Token`, comparaison à temps constant). Motif : les séries exposaient `path="/api/auth/login", status="200"` — donc **quand un administrateur se connecte** et si une force brute est détectée.

## Souveraineté

- **Une seule sortie réseau en plus du fournisseur LLM configuré** (Mistral EU par défaut ; **Ollama** ne sort pas du tout, modèle local) : la **vérification de version**, **activée par défaut** (`update_check_url` → `https://api.github.com/repos/WicaebethTheo/itsm-modern-ai/releases/latest`). Elle est *best-effort*, déclenchée uniquement quand un **admin authentifié** charge la console (`GET /api/version`, sous `require_auth`), **mise en cache** (`update_check_ttl_seconds`, défaut 3 600 s), soumise au garde anti-SSRF, et **lit uniquement** le dernier numéro de version publié + les notes de release : **aucune donnée de l'instance n'est transmise** (pas d'identifiant, pas de télémétrie, requête GET sans corps).
- **Désactivation totale** : `UPDATE_CHECK_URL=` (vide) dans `.env` → aucun appel sortant hors LLM, déploiement **air-gap 100 % hors-ligne**.
- **Licence Supporter vérifiée 100 % hors-ligne** (signature Ed25519, clé publique embarquée) : **aucun serveur de licence**, aucun appel sortant, y compris en air-gap.
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
