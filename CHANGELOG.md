# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/) ; le projet ne suit
pas SemVer strictement (version d'app dans `pyproject.toml`).

Les entrées les plus récentes sont en haut.

## 2026-06-09 — 0.8.14 — Durcissement sécurité (audit)

Corrections issues d'un audit cybersécurité complet — aucun changement du pipeline de triage :

- **XSS stocké (HIGH)** : le brouillon LLM (sortie non fiable, prompt-injectable) est
  désormais **échappé HTML** avant dépôt en Suivi GLPI, en mode public (réponse au
  demandeur) comme privé (lu par le technicien) — `render_followup` dans `services/triage.py`.
- **Docs API exposées (MED)** : `/docs`, `/redoc`, `/openapi.json` **désactivées par
  défaut** (le schéma complet, noms de champs secrets compris, n'est plus public sans auth).
  Réactivables en dev via `EXPOSE_API_DOCS=true`.
- **SSRF (MED)** : le vérificateur de mise à jour passe par le **même garde anti-rebinding**
  (par saut de redirection) que les clients LLM/GLPI, et `update_check_url` est **validée à
  la sauvegarde** (rejet loopback/IP privée/metadata cloud).
- **Cookie de session** : expiration absolue (défaut 12 h, `SESSION_MAX_AGE_SECONDS`).
- **Licence** : borne de taille du jeton (8 Ko) côté API et domaine → pas de parse coûteux.
- **Fail-open masquage (Enterprise)** : alerte WARNING par cycle quand `pii_advanced` est
  **installé mais non licencié** (le masquage IBAN/secrets retombe sinon en silence).
- **Hygiène** : `install.sh` pose `chmod 600` sur `.env` ; rappel de retrait d'`ADMIN_PASSWORD`.

## 2026-06-01 — 0.8.13 — Background atmosphérique + démo statique hébergeable

Travail frontend, sans changement de comportement métier :

- **Fond de la console** : le backdrop n'est plus un aplat. Mesh indigo multi-couches
  (sobre, palette « Operator Preview »), **grain** SVG subtil en overlay et halo discret en
  haut de la zone de contenu — entièrement en CSS, **sous** le contenu (`pointer-events:none`,
  `z-index` maîtrisés), respect de `prefers-reduced-motion`. Le Login reçoit le même backdrop.
- **Démo hébergeable hors produit** : nouveau flag de build **`VITE_DEMO=true`** qui force le
  mode démo (données mockées `demo.ts`, zéro backend) **quel que soit le chemin** — la démo
  n'est plus liée à la route `/demo`. Permet un build statique servi à la racine d'un
  sous-domaine dédié (cf. dossier `ITSM-Modern-Ai-Demo`). Le `basename` du routeur s'adapte :
  racine pour le build dédié, `/demo` pour la démo in-product, inchangé pour l'app réelle.
- **Langue par défaut = EN au premier démarrage** : sans préférence stockée, la console
  s'ouvre désormais en anglais (seul un choix explicite « fr » bascule en français) ;
  `index.html` passe en `lang="en"`. La locale des tests est figée sur `fr` pour conserver
  les assertions existantes ; le nouveau défaut est couvert par `i18n.test.tsx`.

## 2026-05-31 — 0.8.12 — Audit 4 agents : honnêteté DPO + accessibilité

Corrections suite à la revue multi-agents de la 0.8.11 :

- **Honnêteté DPO (bloquant)** : la catégorie **« patterns regex personnalisés »** était
  affichée *Actif/Masqué* en Enterprise alors qu'aucun motif n'est configurable (la capacité
  `AdvancedPiiMasker.from_rules` existe mais n'est pas exposée). Elle passe en statut **« À
  venir »** (scope `roadmap`, jamais active) dans la page, le rapport DPO et la doc — pour ne
  pas tromper la DPO. NIR/SIRET reste réellement masqué.
- **Accessibilité** : la jauge de la page Coûts reçoit `role="progressbar"` + `aria-valuenow/
  min/max/valuetext` (la valeur du quota est désormais annoncée aux lecteurs d'écran).
- **Cohérence démo** : rétention du mock alignée sur les vrais défauts (**365 j décisions /
  90 j appels LLM**, au lieu de 30/30) ; catalogue Store de démo resynchronisé sur le vrai
  catalogue (libellé **« Masquage PII avancé »** au lieu de « (NER) » — la NER n'est pas
  implémentée — et features à venir marquées « (à venir) »).
- NITs front : `CostQuotas` utilise `useLang()` (au lieu de détourner `t()`), `t()` redondant
  retiré dans `Privacy`.

## 2026-05-31 — 0.8.11 — Console DPO + page Coûts & quotas

- **Nouvelle page « Confidentialité (DPO) »** (`/privacy`) destinée à la DPO/RSSI :
  tableau des catégories PII avec leur statut **réel par édition** (email + téléphone
  masqués en Community ; IBAN/cartes, secrets/tokens/clés API, IP/MAC, NIR/SIRET et
  patterns regex custom **verrouillés · Enterprise**), bandeau d'avertissement honnête en
  Community (ces motifs transitent et sont journalisés **en clair**), **outil « Tester le
  masquage »** (applique le masquage réel à un texte), lien vers le journal `llm_calls`,
  rappel des durées de rétention, et **export d'un rapport DPO** (`GET /api/privacy/report.md`).
- **Nouvelle page « Coûts & quotas »** (`/cost`) : dépense LLM des dernières 24 h vs plafond
  journalier glissant (jauge colorée + alerte de dépassement), nombre d'appels journalisés
  et tarifs configurés. Lecture seule (le plafond se règle dans « Moteur »).
- **Backend** : routes `GET /api/privacy`, `POST /api/privacy/test-mask`,
  `GET /api/privacy/report.md`, `GET /api/cost` (protégées par l'auth locale).
- **Cohérence masquage** : le masquage **IP/MAC** suit désormais un flag `network` dédié
  (gaté Enterprise comme dans la fiche DPO), au lieu d'être couplé au flag `phone`.

## 2026-05-31 — 0.8.10 — Audit 4 agents : câblage pii_advanced + honnêteté docs

- **pii_advanced CÂBLÉ** : le masquage avancé (NIR/SIRET + regex custom) est désormais
  réellement appliqué dans le pipeline de triage quand licencié (était enregistré mais
  jamais consommé). Couvert par tests.
- **Docs honnêtes** : `dpo.md` / `README` / `SECURITY.md` reflètent le découpage masquage
  par édition (Community = email+phone ; Enterprise = IBAN/secrets/IP-MAC/NIR-SIRET) +
  caveat « en clair » Community (transit ET journal `llm_calls`). NER retiré (non implémenté).
- multi-entités + exports planifiés marqués **« à venir »** dans le Store (non câblés).
- NITs : alerte d'expiration en `warning`, `prefers-reduced-motion`, garde `--update`/
  `--bundle` (bootstrap), timeout santé upgrade, overlay Enterprise aligné en 0.8.10.

## 2026-05-31 — 0.8.9 — Masquage IBAN + secrets en Enterprise

- En **Community**, seuls **e-mail et téléphone** sont masqués. **IBAN/cartes** et
  **secrets** (mots de passe, tokens, clés API) passent en feature **Enterprise**
  (`FEATURE_PII_ADVANCED`) — toggles verrouillés + **bandeau d'avertissement** clair
  (« envoyés EN CLAIR au LLM »). Docs/Sécurité mises à jour pour refléter ce découpage.

## 2026-05-31 — 0.8.8 — Logo « nœud de décision » (login + sidebar)

- Logo unifié sur le favicon (page de connexion + en-tête sidebar) ; remplace le « M »
  montagne et l'icône bouclier du login.

## 2026-05-31 — 0.8.7 — Nouveau favicon

- Favicon « nœud de décision » (le LLM propose → le code décide), charte indigo.

## 2026-05-31 — 0.8.6 — Audit multi-agents : cohérences

- Overlay Enterprise **réaligné** sur la version du cœur (était figé en 0.7.0).
- `.env.example` : `UPDATE_CHECK_TTL_SECONDS` documenté. Doc de MAJ clarifiée
  (`update.sh` = avec sauvegarde ; `install.sh --update` = rapide). **`les conventions internes`** ajouté
  (conventions : bump version + CHANGELOG + release + docs à jour à chaque changement).
- `is_newer` : comparaison semver robuste aux longueurs inégales (1.0 vs 1.0.0).

## 2026-05-31 — 0.8.5 — Bouton de mise à jour guidé + édition dans la barre

- **Store** : carte « Mise à jour disponible » (notes de release + commande
  `./install.sh --update` + bouton Copier + lien releases). Action privilégiée laissée
  à l'hôte (aucun socket Docker exposé). `/api/version` remonte `latest_notes`.
- **Barre du haut** : badge d'édition (Community / Enterprise) à gauche de l'indicateur
  de version/MAJ.

## 2026-05-31 — 0.8.3 — Vérification de mise à jour automatique

- Cache de vérification ramené de 6 h à **1 h** (configurable `UPDATE_CHECK_TTL_SECONDS`)
  + re-check auto de l'UI toutes les 30 min → une release publiée est détectée **sans
  redémarrage**.

## 2026-05-31 — 0.8.1 → 0.8.2 — Version checker + correctifs install

- **Version checker** (opt-in, souverain — `UPDATE_CHECK_URL` vide par défaut = zéro
  appel sortant) : endpoint `/api/version`, indicateur dans la barre du haut, widget
  flottant (lien GitHub + « Offrir un café »). Le flux gère objet (GitHub) **et** tableau
  (GitLab `/releases`) + redirections.
- **install.sh** : `--update` (git pull + rebuild) ; attente non bloquante (teste
  `/api/status`, fail-fast si crash) ; **mot de passe admin obligatoire** ; build via le
  builder classique (sans buildx) ; bootstrap `curl | sh`. `SESSION_HTTPS_ONLY=false` par
  défaut (pilote HTTP). Sidebar : « Moteur en marche » sans la version (0.8.2).

## 2026-05-31 — 0.8.0 — Open-core : édition Community + overlay Enterprise + licence

Scission en deux éditions partageant la même base (architecture overlay) :

- **Renommage** du dépôt en **édition Community** (le cœur, MIT). Conteneur/image Docker
  renommés `itsm-modern-ai-community`.
- **Système de licence** signé **Ed25519, vérifié 100 % hors-ligne** (zéro phone-home,
  compatible air-gap) : `domain/licensing.py` (vérif + catalogue de features),
  `services/license_service.py`, endpoint `/api/license` (Store), garde `require_feature`.
  La clé **débloque** des features déjà installées — elle ne télécharge rien.
- **Loader à plugins** (`plugins.py`, entry points `itsm_modern_ai.plugins`) : le core
  découvre les modules Enterprise s'ils sont installés. Sur l'image Community, aucun n'est
  installé → features payantes verrouillées même avec une licence valide (garantie de la
  séparation : le code payant n'est pas livré).
- **Page Store** (UI) : édition active, saisie/réinitialisation de clé, catalogue des
  features (verrouillées « Enterprise » vs débloquées).
- **Features Enterprise** (overlay privé, non livré ici) : masquage PII avancé
  (NIR/SIRET/regex custom), multi-entités avancé, exports planifiés/DPO+. Le masquage de
  base, les connecteurs GLPI (legacy + V2) et Postgres **restent en Community**.
- Tests : **295 pytest · 64 vitest** (+ suite dédiée côté overlay Enterprise).

## 2026-05-30 — Audit multi-agents (6) : correctifs ops & frontend

Seconde passe d'audit complet (backend, sécurité, frontend, devops, docs, live). Backend,
sécurité et live confirmés sains. Correctifs des risques trouvés côté ops/frontend :

- **`update.sh` sûr en PostgreSQL** : détecte le moteur (profile `postgres` actif / `ITSM_DATABASE_URL`)
  et fait un **`pg_dump` avant migration** (avant : sauvegarde SQLite vide → migration Postgres
  **sans backup**). Copie SQLite WAL-safe (`itsm.db*`), conscience du profile au redémarrage,
  refus si modifs git locales, attente santé par ID conteneur (timeout configurable).
- **Image Docker PostgreSQL-ready** : `uv sync … --extra postgres` → `psycopg` embarqué, le
  profile `postgres` fonctionne sans rebuild dédié (avant : `ModuleNotFoundError`).
- **Frontend** : plus de **scope OAuth orphelin** envoyé en mode legacy après bascule V2→legacy
  (`GlpiConnection.save()` purge la clé hors V2) ; effet de bord sorti de l'updater `setScopes`.
  Test de régression ajouté.
- `install.sh` : attente santé robuste (par ID) + support non-interactif (`ITSM_ADMIN_PASSWORD`).
- Tests : **276 pytest · 63 vitest**.

## 2026-05-30 — Mise à jour on-premise sûre (`update.sh`)

- **`./update.sh`** : met à jour l'instance avec **sauvegarde préalable** de `./data` (base +
  master key, horodatée sous `backups/`), `git pull`, rebuild + redémarrage, attente santé, et
  **procédure de rollback** affichée en cas d'échec de migration. Les migrations Alembic
  s'appliquent automatiquement au boot ; les données sont préservées (jamais `down -v`).
  `--no-pull` pour ne pas tirer le code. Cibles `make update` / `make backup`.
- Doc « Mise à jour » dans `docs/install.md`, incluant la variante **registry** (image CI
  `:latest`/`:<sha>` → `docker compose pull && up -d`, épinglage/rollback par tag).
- `backups/` ajouté au `.gitignore`.

## 2026-05-30 — Installation en une commande + mot de passe admin sans clair

- **`./install.sh`** : build + démarrage + création du compte admin en une commande. Le mot
  de passe est saisi à l'écran (masqué) et stocké **uniquement en hash Argon2 chiffré** —
  plus besoin de `ADMIN_PASSWORD` en clair dans `.env`. `./install.sh --reset-password` pour
  le rotationner.
- **CLI `python -m itsm_modern_ai.admin_setup`** (`--force`, `--check`) : amorçage/rotation du
  mot de passe admin (prompt masqué, ou `ITSM_ADMIN_PASSWORD`/stdin en non-interactif).
  Cible `make set-admin-password`. Comble le manque de rotation (jusqu'ici uniquement via `.env`).
- `ADMIN_PASSWORD` (`.env`) rétrogradé en **fallback optionnel** (CI/non-interactif), commenté
  par défaut dans `.env.example` ; ignoré dès qu'un hash existe.
- Tests : **276 pytest · 62 vitest** (`tests/unit/test_admin_setup.py`).

## 2026-05-30 — Audit multi-agents : correctifs moteur + cohérence

Vérification complète du projet (5 agents : backend/archi, sécurité, frontend, docs, live).
Sécurité : aucun finding critique/élevé (durcissements intacts, secrets OK, endpoints auth OK).

- **Correctif (moteur)** : `confidence_threshold` (FR-8) et `cost_cap_eur_per_day` (FR-10)
  étaient réglables dans l'UI mais le moteur lisait la valeur `.env` figée → réglages
  **silencieusement ignorés**. Désormais résolus en config runtime (UI > `.env`) dans
  `build_triage_service` et utilisés par `TriageService`. Régression couverte
  (`test_runtime_confidence_threshold_is_honored`).
- **Cohérence doc** : `docs/glpi-api-v2.md` + `.env.example` documentent les deux URL de base
  distinctes (`GLPI_BASE_URL` legacy / `GLPI_V2_BASE_URL` v2) et `GLPI_OAUTH_SCOPE`.
- Tests : **272 pytest · 62 vitest** verts.

## 2026-05-30 — UX connexion GLPI + durcissement V2 (Beta)

- **Scopes OAuth** : le connecteur V2 demande désormais `api user` par défaut (configurable,
  `GLPI_OAUTH_SCOPE` / sélection multiple dans l'UI). `api` seul suffit au triage mais
  `/Administration/User/Me` (aperçu du compte) exige `user` — diagnostiqué en live (403
  `ERROR_RIGHT_MISSING`). Token OAuth envoyé en **form-urlencoded** (standard, vérifié live).
- **Deux URL de base distinctes** : `glpi_base_url` (legacy apirest.php) et `glpi_v2_base_url`
  (api.php/v2.3) coexistent — plus de champ partagé ambigu. Le lien web du Journal suit le
  mode actif (`active_glpi_base_url`).
- **Réinitialisation** : `POST /api/glpi/reset` + bouton UI « Réinitialiser » effacent toute
  la connexion GLPI (URLs, tokens, identifiants OAuth) d'un coup.
- **UI** : page Connexion GLPI cohérente legacy/V2 — sélecteur d'API, URL dédiée par mode,
  scopes en cases à cocher, aperçu « compte du bot » (avatar/photo), message de test inline.
- **Correctif tz (V2)** : l'API V2 renvoie des dates timezone-aware → normalisées en naïf UTC
  dans le mapper (sinon `get_recent_tickets` levait `offset-naive vs offset-aware` sur le
  Dashboard). Trouvé en vérification live.
- **Parité legacy↔V2 complétée** (audit fonction par fonction) :
  - `server_version` (V2) via `GET Setup/Config/core/version` (scope `api`) → la version GLPI
    (ex. 11.0.7) s'affiche dans la topbar **aussi en V2** (avant : « GLPI connecté » seul).
  - `technician_profiles` (V2) renseigné depuis le `default_profile` de chaque User (le legacy
    joint tous les profils ; la V2 expose le profil par défaut → approximation).
- **Indicateur d'API** en pied de sidebar (au-dessus de « Moteur en marche ») : « API GLPI :
  V2 (OAuth2) » ou « apirest » selon le mode configuré.
- **Validé en live** contre une instance GLPI 11.0.7 réelle : OAuth (api+user), `whoami`,
  `server_version` (11.0.7), référentiels (cat:8/tech:63/grp:2/ent:1 + 15 profils), tickets
  « New », tickets récents. Écritures (suivi, assignation) couvertes par tests/contrat, non
  exécutées en live (mutation de tickets réels).
- Tests : **271 pytest · 62 vitest**.

## 2026-05-30 — Moyen terme : PostgreSQL + connecteur GLPI API V2 (**Beta**)

> ⚠️ **Beta — encore tout jeune.** Les deux fonctionnalités sont **opt-in** ; les défauts
> (SQLite + GLPI legacy `apirest.php`) sont **inchangés**. À éprouver avant la prod.

### PostgreSQL (Beta) — `docs/postgresql.md`
- Driver `psycopg` 3 en **extra optionnel** (`uv sync --extra postgres`).
- `db.init_engine` : pooling (`pool_pre_ping` + `pool_size`/`max_overflow`) pour toute base
  réseau ; SQLite inchangé. Nouveaux réglages `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` /
  `DB_POOL_PRE_PING`.
- `docker-compose.yml` : service `postgres` **optionnel** (profile `postgres`, non lancé par
  défaut) ; `DATABASE_URL` du conteneur surchargeable via `ITSM_DATABASE_URL`.
- **Vérifié** : les 8 migrations Alembic + un aller-retour ORM (tz-aware) tournent sur un
  PostgreSQL 16 réel.

### Connecteur GLPI API V2 (Beta) — `docs/glpi-api-v2.md`
- Nouveau `adapters/itsm/glpi/v2/` (client OAuth2 password grant + Bearer + anti-SSRF,
  connector `ItsmPort`, mapper objets imbriqués `{id,name}` + `team`).
- API haut-niveau GLPI 11 : `/Assistance/Ticket` (PATCH), `Timeline/Followup`, `TeamMember`
  (assignation), `Dropdowns/ITILCategory`, `Administration/User|Group|Entity`, recherche RSQL.
- Bascule `GLPI_API_VERSION=legacy|v2` ; identifiants OAuth (`GLPI_OAUTH_CLIENT_ID/USERNAME`
  non-secrets, `client_secret`/`password` chiffrés via l'UI). Contrat ancré sur le spec
  OpenAPI réel d'une instance GLPI 11.0.7 (`/api.php/v2.3/doc.json`).
- Couvert par `tests/integration/test_glpi_v2_connector.py`. Tests : **259 pytest** verts.

## 2026-05-30 — Correctif : lien GLPI versionné (`api.php/v1`) pointait sur l'API

- **Bug** : avec une URL API GLPI **versionnée** (`https://host/api.php/v1`), le lien du
  ticket visait `…/api.php/v1/front/ticket.form.php?id=…` → l'API GLPI répondait
  `ERROR_APP_TOKEN_PARAMETERS_MISSING` au lieu d'ouvrir le ticket dans l'UI web. Cause :
  `ticket_web_link` ne retirait que le **suffixe** `/apirest.php` ou `/api.php` en fin de
  chaîne, donc `/api.php/v1` n'était pas reconnu.
- **Correctif** (`services/links.py`) : on **tronque à partir** du marqueur (`/apirest.php`
  ou `/api.php`), quel que soit ce qui suit (`/v1`, `/v1/`, …) → racine web correcte
  `https://host/front/ticket.form.php?id=<id>`. Le lien étant reconstruit à la lecture,
  les décisions déjà journalisées sont corrigées sans migration. Couvert par
  `tests/unit/test_links.py::test_strips_versioned_api_php`. Tests : **246 pytest** verts.

## 2026-05-30 — Correctif : lien GLPI du Journal cliquable en production

- **Bug** : dans le *Journal des décisions*, le **Sujet** n'était cliquable (lien vers le
  Ticket GLPI) qu'en mode `/demo`, pas en production. Cause : le lien était figé à
  l'enregistrement à partir de `Settings.glpi_base_url` (valeur **`.env`**, vide en prod
  où GLPI se configure via l'UI → table `RuntimeConfig`). `glpi_link` était donc stocké
  à `""` et le frontend rendait le sujet en texte brut.
- **Correctif lecture** (`api/routes/decisions.py`) : le lien front est désormais
  **reconstruit à la lecture** depuis l'URL GLPI **runtime** (config UI), avec repli sur
  le lien stocké. Répare aussi les décisions **déjà enregistrées** avec un lien vide et
  reste valide si l'URL GLPI change.
- **Correctif écriture** (`api/runtime.py` + `services/triage.py`) : `build_triage_service`
  résout `glpi_base_url` via la config runtime (UI > `.env`) et l'injecte dans
  `TriageService` → les nouvelles décisions (et l'export CSV) portent le bon lien.
- Régression couverte par `tests/integration/test_audit_auth_api.py`
  (`test_journal_link_rebuilt_from_runtime_glpi_url`). Tests : **245 pytest** (verts),
  ruff propre. Aucun changement frontend (le rendu `<a href>` était déjà correct).

## 2026-05-29 — Vague « audit-2026-05 » : durcissement sécurité, observabilité, build

Audit multi-agents (ancrage **OWASP LLM Top 10 2025**, **AI Agent Security Cheat Sheet**,
revue *production readiness*) suivi de quatre lots de correctifs. Synthèse complète,
tableau des vulnérabilités et **risques résiduels** dans [`docs/audit-2026-05.md`](docs/audit-2026-05.md).
Aucun changement de fonctionnalité métier visible. Tests : **244 pytest** (verts), ruff propre.

### Sécurité

- **Path traversal SPA confiné** (`api/spa.py`) : tout chemin statique est résolu et
  doit rester **sous `dist/`** (`is_relative_to`). Bloque `..%2f..%2f` → lecture de
  `master.key` / `itsm.db` / `.env`. Couvert par `tests/integration/test_spa_security.py`.
- **Séparation des clés de chiffrement et de signature de session (HKDF-SHA256)** :
  la clé Fernet ne sert plus *aussi* de secret de session. `FernetSecretsBox.derive_key(info=…)`
  dérive une sous-clé dédiée (`encrypted.py`), et `app.py` l'emploie pour la session
  (`info=b"session-signing"`). Secret **distinct** et **stable** entre redémarrages.
- **Authentification fail-closed** (`api/security.py`) : sans mot de passe admin
  configuré, l'admin est désormais **refusé (401)** par défaut. L'ancien comportement
  « ouvert » (réseau interne) doit être activé explicitement via le nouveau réglage
  `dev_open_admin` (dev/labo). Couvert par `tests/integration/test_audit_auth_api.py`.
- **Anti-SSRF lexical** (`domain/url_safety.py` + validateurs `api/routes/config.py`) :
  les URLs de base poussées via l'API (GLPI, LLM) exigent `https://` + un hôte routable ;
  loopback/IP privée/metadata cloud rejetés à l'écriture (Ollama : `http`+local toléré).
- **Anti-SSRF runtime / anti DNS-rebinding** (`url_safety.assert_resolved_ip_is_public`
  + hooks httpx `adapters/llm/_http.py`) : avant chaque appel sortant, l'hôte est **résolu**
  et toute IP interne est **bloquée** (fail-closed sur échec DNS) — *avant* l'envoi du
  token. Activé par `ssrf_guard_enabled` (défaut `true`). `tests/unit/test_url_safety.py`.
- **Re-masquage des brouillons en modes auto** (`services/triage.py`) : avant toute
  publication **publique** (semi_auto/full_auto), le brouillon LLM est **re-masqué** et
  borné en longueur (`PUBLIC_DRAFT_MAX_CHARS`). Le mode suggestion (privé) est inchangé.
- **Masquage PII étendu** (`domain/masking.py`) : ajout cartes bancaires (validation
  **Luhn**), **IPv4**, **MAC**, téléphone **E.164 international**, clés cloud (AWS `AKIA…`,
  Google `AIza…`) → `[CARD]`/`[IP]`/`[MAC]`/`[PHONE]`/`[CLOUD_KEY]`. `tests/unit/test_masking.py`.
- **Neutralisation de l'injection de formule CSV** (`persistence/journal.py`) : les
  cellules d'export commençant par `= + - @ \t \r` sont préfixées d'une apostrophe.
  `tests/unit/test_cost_cap_journal.py`.
- **Décryptage fail-safe** : un secret illisible (MASTER_KEY incohérente) lève une
  `SecretDecryptError` métier (`domain/errors.py`) au lieu d'un 500 qui verrouillait
  l'admin ; le bootstrap auth la traite comme « non amorcé » (fail-closed propre).
- **Cookie de session `Secure`** pilotable via `session_https_only` (défaut `true`).

### Observabilité

- **Logging structuré** (`config/logging.py`) : `log_level` + `log_format` (`text`|`json`),
  init centralisée au démarrage. Le format JSON n'inclut **aucune PII**. `tests/unit/test_logging_config.py`.
- **Endpoint Prometheus `GET /metrics`** (`api/metrics.py`, hors `/api`) : compteur de
  requêtes + histogramme de latence, label `path` = **route templatée** (cardinalité
  bornée, pas de PII). Désactivable (`metrics_enabled`) et **protégeable** par
  `metrics_token` (Bearer / `X-Metrics-Token`, comparaison à temps constant).
  `tests/integration/test_metrics_endpoint.py`.

### Build & CI

- **Build reproductible** : `uv.lock` figé, `Dockerfile` installe depuis le lock,
  Python aligné **3.13** partout (pyproject `requires-python >=3.13`, image, CI).
- **CI** : nouveau job `package:image` (build/push image) dans `.gitlab-ci.yml`.
- **Durcissement `docker-compose.yml`**.

### Qualité

- **Sandbox lit le périmètre EFFECTIF en base** (`api/routes/sandbox.py`) et non le
  cache mémoire (vide si polling off). Garde-fou de non-régression ajouté :
  `tests/integration/test_sandbox_api.py::test_sandbox_uses_db_scope_even_without_cache`.
- **Borne de génération LLM** (`max_tokens`, défaut 1024) sur l'adaptateur
  OpenAI-compatible (aligné sur Anthropic) — plafonne coût/latence (LLM10).
- **Test d'architecture des ports** : `tests/unit/test_architecture.py::test_ports_depend_only_on_domain`
  vérifie que `ports/` ne dépend que de `domain` (+ stdlib/typing/pydantic).
- **Versions unifiées 0.7.0**.

### Documentation

- Nouveau document de synthèse d'audit [`docs/audit-2026-05.md`](docs/audit-2026-05.md).
- `SECURITY.md`, `docs/llm-providers.md`, `docs/dpo.md`, `docs/install.md`, `docs/api.md`,
  `README.md`, `docs/project-context.md` mis à jour (nouveaux réglages, `/metrics`,
  logging, masquage étendu, Python 3.13, compteur de tests **244**).

## 2026-05-29 — Docs : sortie du planning interne du repo public

Sortie des artefacts internes du repo public vers un dossier `notes/`
(gitignored) : `HANDOFF.md` (archives de passation IA), `bootstrap-archive.md`
(archive d'amorçage) et tout `docs/planning/` (PRD, architecture
détaillée, epics, addendum). Le repo public garde le README pro,
`docs/install.md`, `docs/dpo.md`, `docs/spike.md`, `docs/project-context.md`
(invariants), `docs/design/` et les conventions racine (LICENSE,
SECURITY, CHANGELOG). Refs README et `project-context.md` mises à jour.

## [Non publié] — 2026-05-29

Toilettage code/archi de fond (5 phases — aucun changement de fonctionnalité visible).
Tests : **177 → 180 pytest**, vitest **58/58**, E2E Playwright **2 → 3 parcours**.

### Sécurité

- **Trust proxy headers** pour le rate-limit login (anti brute-force). Nouveau helper
  `api/client_ip.py` qui lit `X-Forwarded-For` derrière un reverse proxy fiable. Activé
  par le réglage `trust_proxy_headers: bool = False` (défaut sûr) et propagé à uvicorn
  via `entrypoint.sh` lorsque `TRUST_PROXY_HEADERS=true`. Sans ce correctif, toutes les
  requêtes paraissaient venir de l'IP du proxy → rate-limit contournable. Couvert par
  `tests/unit/test_client_ip.py` (5 cas).
- `auth.py` et `automations.py` utilisent désormais ce helper plutôt que
  `request.client.host` brut.
- `docs/install.md` + `.env.example` documentent la configuration reverse proxy.

### Persistance

- `ProcessedTicket.processed_at` passe en `UtcDateTime` indexée (cohérent avec le Lot C
  MR !19 qui avait traité `DecisionLog.ts` et `LlmCall.ts`). Migration Alembic
  `d2f8a9c5_processed_tickets_ts_aware`. Évite un `TypeError` au futur portage Postgres
  lors des comparaisons `cutoff < processed_at`. Test ajouté dans `test_tz_aware_ts.py`.

### Frontend (i18n)

7 chaînes UI hardcodées sont désormais passées par `useT()` :
`LangToggle` (aria-label, title), `ThemeToggle` (label, libellé bouton), `Layout`
(`title="Administrateur"`), `ui/toast.tsx` (`aria-label="Fermer"`),
`AiProvider` (`Field label="Base URL"`), `Debug` (`title="Diagnostics"`),
`Automations` (`title="Automations"`).

### Tests ajoutés

- **Routage groupe** (bout-en-bout) : `test_group_routing_writes_followup_and_applies_in_full_auto`
  et `test_group_routing_accepted_in_suggestion_mode`. Vérifie que `apply_decision` est
  invoqué avec `group_id` (et `technician_id=None`) en `full_auto`, et qu'aucune mutation
  n'a lieu en `suggestion`.
- **Cost cap chaîné** : `test_cost_cap_blocks_subsequent_tickets_same_day`. Vérifie
  qu'un 2ᵉ ticket dans le même cycle est aussi blocké après dépassement du cap.
- **E2E Playwright** : nouveau parcours `frontend/e2e/sandbox.spec.ts` (login →
  bac à sable → décision simulée avec résolution de nom de catégorie + technicien).

### Cosmétique

- Constante `DEFAULT_DECISIONS_LIMIT = 500` extraite dans `persistence/journal.py`,
  réutilisée par `api/routes/decisions.py` (au lieu du nombre magique dupliqué).
- `datetime.now(UTC)` → `_utcnow()` dans `persistence/journal.py:daily_series`
  (cohérent avec le reste du module).
- Commentaire de robustesse au-dessus de `SYSTEM_PROMPT` dans `domain/prompting.py` :
  explique que `category: int | None` accepte null (au cas où le LLM ignore le prompt),
  et que la whitelist rejette alors en « à trier ».

### Documentation

- README et HANDOFF : compteurs de tests à jour (**177 pytest**, **58 vitest**, **2
  parcours E2E**), liste complète des endpoints (ajoute `operational-metrics`,
  `automations/retention*`, `debug/*`), pistes ouvertes § 8 nettoyées (version GLPI
  topbar marquée ✅ fait, durcissement prod partiel précisé).
- Plan `notes/planning/plan.md` annoté COMPLET.
- Réorganisation des docs : `docs/design/` regroupe les specs design ; le doc
  d'amorçage initial est renommé `docs/bootstrap-archive.md` pour le distinguer
  du `HANDOFF.md` actif.

## 2026-05-28 — Lot C + Lot 4 (MR !19)

- **Audit cybersécu Lot C** : `DateTime(timezone=True)` sur `DecisionLog.ts` et
  `LlmCall.ts` via le nouveau `UtcDateTime` TypeDecorator
  (`persistence/tables.py`). Migration `c1a7e4b2_ts_timezone_aware`. Préparation
  au portage Postgres (sans ça, `cutoff < ts` casse avec `TypeError`).
- **Factorisation httpx LLM (Lot 4)** : nouveau `adapters/llm/_http.py` exposant
  `arequest()` (avec capture du body 4xx pour diagnostic) et `healthcheck_get()`.
  Utilisé par `openai_compatible.py` et `anthropic.py`.
- Tests : `tests/unit/test_tz_aware_ts.py` (5 cas) et `tests/unit/test_llm_http_helper.py`
  (8 cas).

## 2026-05-27 — UI sandbox, modes, toasts, i18n complet, écarts post-pilote

- **Toasts** UI : nouveau `components/ui/toast.tsx` + `ToastProvider` global ; toutes les
  pages avec « Enregistrer » donnent un feedback succès/erreur.
- **Bac à sable** : résolution des noms (catégorie, technicien, groupe) côté API
  (`api/routes/sandbox.py`) + affichage coloré (Tags) côté UI (`pages/Sandbox.tsx`).
  Persistance du filtre « éligibles seulement » dans `RefEligibilityEditor`
  (localStorage par kind).
- **Adaptateur Anthropic** : suppression du préfill assistant (refusé par Sonnet 4.6+),
  extracteur tolérant de JSON, capture body 4xx, `Decision.category` désormais `int | None`.
- **Périmètre** (`Scope.tsx`) : boutons « tout sélectionner » pour Entités et Catégories.
- **Documentation** : `priorityLabel`, `priorityTone`, `confidenceTone` dans
  `frontend/src/lib/labels.ts`.

## Phases initiales — Epics 1 → 5 (résumé)

- **Epic 1 — Spike** (`scripts/spike_routing.py` + `tests/fixtures/tickets_fr.json`) :
  validation du routage par fiches en prose + précision LLM sur tickets FR.
- **Epic 2 — Fondations & connexion GLPI** : connecteur legacy `apirest.php`,
  polling idempotent (APScheduler), suivi privé `ITILFollowup`.
- **Epic 3 — Moteur à garde-fous** : pipeline immuable masquage → LLM → Pydantic →
  whitelist → seuil → suivi/à trier ; mode suggestion ; cost cap.
- **Epic 4 — Audit & packaging** : journal annotable, export CSV DPO, auth Argon2,
  secrets Fernet, conteneur non-root, healthcheck.
- **Epic 5 — Console web** (post-GO) : SPA React 19 + Vite + Tailwind v4, 4 fournisseurs
  LLM, scan GLPI + sélection de périmètre (catégories, entités, techniciens, groupes)
  avec fiches en base, modes d'exécution par entité (`suggestion`, `semi_auto`,
  `full_auto`), masquage PII configurable.
