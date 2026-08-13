# Politique de sécurité — ITSM Modern AI (pilote V1)

## Posture

Déploiement pilote prévu pour un réseau interne non exposé. La base de référence sécurité est dimensionnée pour ce contexte et doit être durcie avant tout déploiement payant (PRD §12). Ce document décrit l'état du pilote, pas une cible de production.

## Secrets

- La clé API du fournisseur LLM (Mistral EU, OpenAI ou Anthropic ; Ollama, étant local, n'utilise aucune clé) et les tokens GLPI se poussent via l'API/UI de configuration (`POST /api/config`), jamais via `.env`.
- Ils sont chiffrés au repos avec **Fernet** (bibliothèque `cryptography`), FR-25.
- **Master key** : la clé de chiffrement provient de `data/master.key` ou de la variable d'environnement `MASTER_KEY`. Elle vit dans le volume applicatif (`itsm_data`), séparément des données (volume du cluster PostgreSQL) : une sauvegarde n'est complète que si elle emporte les deux. Sans la clé, une base restaurée est définitivement illisible (hash admin, tokens GLPI, clé LLM) ; c'est pourquoi `python -m itsm_modern_ai.backup` les écrit ensemble.
- **Aucun secret APPLICATIF en clair** (clés LLM, tokens GLPI) : ni en base, ni dans `.env`, ni dans les logs.
  ⚠️ En revanche, `.env` porte par conception deux éléments sensibles : la `MASTER_KEY`, celle qui déchiffre tous les autres secrets, et le mot de passe de la base (`POSTGRES_PASSWORD`, répété en clair dans `ITSM_DATABASE_URL` ; les deux doivent rester cohérents). `data/master.key` est également en clair sur disque (mode `0600`). `install.sh` pose `chmod 600` sur `.env` ; un `.env` déployé à la main doit l'être aussi. Ces fichiers donnent accès au reste.
  Le mot de passe administrateur n'y figure plus : il n'est plus amorcé par variable d'environnement (`ITSM_ADMIN_PASSWORD` a été supprimé, aucune valeur n'est lue), il est choisi à la première visite de la console. Un mot de passe passé par l'environnement traînait dans `docker inspect`, dans l'historique du shell, dans les logs de l'orchestrateur et dans les sauvegardes de `.env` : quatre copies en clair d'un secret dont on affirmait par ailleurs qu'il n'existait que sous forme de hash.
- La base n'est publiée sur aucun port : les composes livrés ne définissent pas de `ports:` pour le service `postgres`, qui n'est joignable que depuis le réseau de la stack. L'exposer n'offrirait qu'un service d'authentification de plus à un attaquant, alors que `docker compose exec postgres psql` suffit à l'exploitation. Le mot de passe livré par défaut (`itsm`/`itsm`) doit néanmoins être changé avant le tout premier démarrage : passé l'initialisation du cluster, il faut un `ALTER USER`.
- **Séparation des usages de clé** (durcissement audit 2026-05) : la clé Fernet ne sert plus aussi de secret de signature des sessions. Le secret de session est dérivé par HKDF-SHA256 (`derive_key(info=b"session-signing")`), clé distincte et stable entre redémarrages.
- **Décryptage fail-safe** : un secret illisible (MASTER_KEY incohérente / token corrompu) lève une erreur métier (`SecretDecryptError`) au lieu d'un HTTP 500, ce qui évite de verrouiller l'admin derrière une erreur serveur opaque ; le secret est à reconfigurer.

## Authentification

- **Authentification locale** pour les fonctions d'administration et d'export (FR-24). Un seul compte administrateur, pas de multi-utilisateur.
- Identifiants = email + mot de passe. Le mot de passe est haché avec Argon2, le hash lui-même chiffré (Fernet) en base ; gestion par session. L'adresse est stockée en clair sous une clé réservée, hors `/api/config`, et n'est jamais renvoyée par une route publique (la diffuser à un anonyme lui offrirait la moitié du couple à deviner).
- Le compte se crée à la première visite (`POST /api/auth/setup`), plus par une variable d'environnement. La route est publique, puisque par construction il n'existe aucun identifiant pour l'atteindre, mais fail-closed : dès qu'un compte existe, elle répond 409 sans rien modifier. Elle est comptée par le même rate-limit que le login.
- **Réponses d'échec indistinctes** : email inconnu et mot de passe faux donnent le même code et le même message, et `verify_login` paie le coût d'un hash dans tous les cas ; sans quoi la route deviendrait un oracle d'énumération des comptes, par le texte ou par le chronomètre.

  > ### ⚠️ Risque assumé — fenêtre de revendication
  > Entre le démarrage du conteneur et la création du compte, quiconque atteint le port peut revendiquer l'administration de l'instance.
  >
  > Le choix de ne poser ni jeton d'amorçage ni fenêtre temporelle est délibéré, au profit de la simplicité : les deux auraient réintroduit un secret à transporter (fichier à lire, variable à définir, horloge à surveiller), exactement ce que cette version supprime.
  >
  > Conséquence pratique : n'exposez pas le port publiquement avant d'avoir créé votre compte. L'exposition d'un port à Internet avant la première connexion équivaut à publier un mot de passe administrateur vierge.
  >
  > La seule contre-mesure retenue est de le dire, et de le répéter : tant qu'aucun compte n'existe, le moteur journalise à chaque démarrage un `WARNING` (`AUCUN COMPTE ADMINISTRATEUR : cette instance est REVENDICABLE …`, cf. `security.warn_if_setup_required`), et la création du compte est elle-même journalisée avec l'IP d'origine, seul élément d'imputabilité disponible pour un compte qui n'existait pas encore. Un exploitant qui surveille ses logs voit donc l'instance réclamer d'être revendiquée, puis constate qui l'a fait.
  >
  > Ce que ce risque ne couvre pas : une instance déjà revendiquée. Passé la création, `POST /api/auth/setup` répond 409 et le compte en place est intouchable par cette voie.

- **Mot de passe oublié** : aucune réinitialisation par email (le produit ne parle à aucun serveur SMTP, par souveraineté). Le seul chemin de récupération est la CLI livrée dans l'image, `docker compose exec itsm python -m itsm_modern_ai.admin_setup --force` : un accès shell à l'hôte est donc le facteur d'authentification de dernier recours, et quiconque l'obtient peut reprendre l'instance (il pouvait déjà lire `master.key` dans le volume, cette CLI n'élargit pas la surface). Le mot de passe est saisi de façon masquée ou lu sur `stdin` ; il n'est jamais lu dans l'environnement, précisément pour ne pas laisser de copie en clair derrière lui.
- **Fail-closed** (durcissement audit 2026-05) : si aucun compte admin n'est configuré, les endpoints d'admin sont refusés (401) par défaut. L'ancien comportement « ouvert » (pilote réseau interne) doit être activé explicitement via le réglage `dev_open_admin=true`, réservé au dev/labo et jamais à la production. ⚠️ Ce réglage est plus dangereux qu'avant : une instance neuve est désormais, normalement, sans compte, et `dev_open_admin=true` y ouvre l'admin sans la moindre saisie.
- **Révocation de session** : le cookie porte une génération de session, revérifiée à chaque requête. Le logout et tout changement de mot de passe admin l'incrémentent : une session volée cesse donc d'être valable, sans store partagé. (Auparavant, la seule parade était de changer `MASTER_KEY`, ce qui rendait illisibles tous les secrets et verrouillait la console.)
- **Journal d'audit des actions d'administration** (`audit_log`) : toute écriture de configuration est tracée (acteur = IP, action, clé, ancienne → nouvelle valeur), secrets remplacés par `***`. Inclut le passage d'une entité en `semi_auto`/`full_auto`, qui autorise l'IA à muter des Tickets et à répondre publiquement. Table exclue de la purge RGPD : la purger sur la fenêtre « tickets » offrirait un effacement de traces trivial. ⚠️ Deux limites à connaître avant de s'engager sur une exigence d'auditabilité. (1) La table est écrite mais lue par aucune route, aucun écran et aucun export : la seule voie de consultation est un `psql` direct sur le cluster. (2) `actor` porte une IP et la table est exclue de la purge, donc ces IP s'accumulent sans borne, sans chemin d'accès ni d'effacement offert par le produit ; une fenêtre de conservation dédiée reste à décider explicitement.
- **Rate-limit du login** (anti brute-force) en mémoire par IP : mono-process pilote, pas de store partagé, pas de HA. Honore `X-Forwarded-For` si `trust_proxy_headers=true`.
- **2FA TOTP** : en alpha, non implémentée à ce jour dans le produit. À ne pas considérer comme un contrôle disponible, ni la présenter comme telle en audit.

## Transport

- **HTTPS via reverse proxy** (nginx, Caddy, …) devant le service (FR-26). La terminaison TLS est déléguée au proxy ; le HTTP nu doit être redirigé ou refusé au niveau du proxy.
- **Cookie de session `Secure`** : flag `https_only` piloté par `session_https_only` ; `SameSite=lax`. `false` = acceptable pour un pilote en HTTP sur réseau interne (posture livrée par défaut) ; `true` obligatoire dès que le service est derrière un TLS (le middleware ajoute alors aussi `Strict-Transport-Security`).
- **En-têtes de sécurité HTTP** sur toutes les réponses : `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` ; CSP sur le HTML de la SPA (`default-src 'self'`, `frame-ancestors 'none'`).

## Garde-fous applicatifs (durcissement audit 2026-05)

- **Anti-path-traversal (SPA)** : le service de fichiers statiques résout le chemin demandé et exige qu'il reste sous `dist/` ; toute tentative de sortie (`../`, `..%2f`) retombe sur l'index SPA. Pas de lecture de `master.key`, des sauvegardes du volume (`data/backups/*/itsm.dump`) ni de `.env`.
- **Anti-SSRF — validation lexicale** (écriture de config) : les URLs de base publiques (GLPI, Mistral, OpenAI, Anthropic) exigent `https://` et un hôte routable ; loopback / IP privée / metadata cloud sont rejetés (Ollama local toléré).
- **Anti-SSRF — garde runtime / anti DNS-rebinding** (`ssrf_guard_enabled`, défaut `true`) : avant chaque appel sortant (LLM, GLPI), l'hôte est résolu et toute IP interne est bloquée (fail-closed sur échec DNS), donc avant toute fuite de token. Atténuation : une limite TOCTOU résiduelle (fenêtre entre la résolution DNS vérifiée et la connexion effective) est connue et assumée.
  ⚠️ Exception livrée par défaut : `glpi_allow_private_host=true` (alias `GLPI_ALLOW_PRIVATE`) désactive ce garde pour les seuls connecteurs GLPI, sans quoi le produit ne pourrait pas atteindre un GLPI on-premise, qui vit presque toujours sur une IP privée ou un nom `.local`. La phrase ci-dessus est donc vraie pour le LLM et le vérificateur de version en toute circonstance, et pour GLPI seulement si ce flag est repassé à `false`. Le compromis est délibéré ; il doit être connu avant d'affirmer que « toute IP interne est bloquée ».
- **Masquage PII avant le LLM**, selon la licence (open-core) : sans licence, seuls e-mail + téléphone sont masqués ; le masquage IBAN/cartes, secrets (mots de passe/tokens/clés API), IP/MAC, NIR/SIRET est une feature Supporter (les regex custom sont en roadmap) (`FEATURE_PII_ADVANCED`), dont le code est livré dans l'image mais reste verrouillé tant qu'aucune licence valide ne l'autorise. ⚠️ Sans licence, IBAN et secrets sont transmis EN CLAIR au LLM et conservés en clair dans le journal `llm_calls` ; un bandeau l'indique dans la console (cf. la console **DPO** et [docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)).
- **Re-masquage des brouillons en modes auto** : avant toute publication publique (`semi_auto`/`full_auto`), le brouillon LLM est re-masqué (PII, selon la licence) et borné en longueur.
- **Bornes de génération LLM** (`max_tokens`) : plafonne coût/latence (consommation non bornée, OWASP LLM10).
- **Neutralisation de l'injection de formule CSV** : les cellules d'export DPO commençant par `= + - @ \t \r` sont préfixées d'une apostrophe (protège tableurs).
- **Fenêtre d'idempotence** (risque résiduel assumé) : le poller marque un Ticket `processed` après l'action. Un arrêt brutal entre la mutation GLPI et ce marquage peut, au cycle suivant, produire une seconde mutation et une seconde réponse publique, en modes `semi_auto`/`full_auto` uniquement. En mode `suggestion` (défaut) l'impact est nul : au pire un Suivi privé en double. Fenêtre connue et assumée (pas de transaction distribuée avec GLPI).

## Observabilité

- **Logging structuré** : `log_level` + `log_format` (`text`|`json`). Le format JSON n'inclut aucune PII (pas de corps de requête ni de query string).
- **Métriques Prometheus** : `GET /metrics` (hors `/api`), volumétrie + latence par route templatée (pas de PII dans les labels). Désactivable (`metrics_enabled`). Depuis la 0.9.48, l'endpoint n'est plus anonyme par défaut : sans `metrics_token` configuré, il exige une session administrateur ; avec un jeton, le scrape machine reste anonyme (`Authorization: Bearer …` ou `X-Metrics-Token`, comparaison à temps constant). Motif : les séries exposaient `path="/api/auth/login", status="200"`, donc quand un administrateur se connecte et si une force brute est détectée.

## Souveraineté

- **Une seule sortie réseau** en plus du fournisseur LLM configuré (Mistral EU par défaut ; Ollama ne sort pas du tout, modèle local) : la vérification de version, activée par défaut (`update_check_url` → `https://api.github.com/repos/WicaebethTheo/itsm-modern-ai/releases/latest`). Elle est *best-effort*, déclenchée uniquement quand un admin authentifié charge la console (`GET /api/version`, sous `require_auth`), mise en cache (`update_check_ttl_seconds`, défaut 3 600 s), soumise au garde anti-SSRF, et lit uniquement le dernier numéro de version publié + les notes de release : aucune donnée de l'instance n'est transmise (pas d'identifiant, pas de télémétrie, requête GET sans corps).
- **Désactivation totale** : `UPDATE_CHECK_URL=` (vide) dans `.env` → aucun appel sortant hors LLM, déploiement air-gap 100 % hors-ligne.
- **Licence Supporter vérifiée 100 % hors-ligne** (signature Ed25519, clé publique embarquée) : aucun serveur de licence, aucun appel sortant, y compris en air-gap.
- Application 100 % on-premise sur l'infrastructure du client.
- **Périmètre d'action restreint par sélection admin** : l'IA n'agit que sur les catégories, techniciens, groupes et entités explicitement autorisés par l'admin (Whitelist curée depuis un scan GLPI). Tout ID hors de ce périmètre effectif est rejeté → Ticket « à trier », aucune écriture (FR-7).

## Signaler une vulnérabilité

Merci de signaler toute vulnérabilité de manière responsable et privée : n'ouvrez
pas d'issue, de merge request ni de fil public pour une faille non corrigée.

**Contact** : support@itsm-modern-ai.com (l'alias relaie en privé au mainteneur).

Incluez de quoi reproduire : la version testée (tag `vX.Y.Z` ou SHA), l'endpoint/route
concerné, le comportement attendu vs constaté, et un PoC minimal si possible.

### Périmètre

**En périmètre** : le moteur de triage (polling GLPI, routage LLM, validation des décisions,
authentification/sessions, anti-SSRF, masquage PII, endpoints d'admin/export).
**Hors périmètre** : la mauvaise configuration d'un déploiement (TLS absent, port exposé, SSH
faible, responsabilité du déployeur) et les avis de dépendances sans chemin de code
atteignable (merci de joindre une preuve d'atteignabilité).

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
