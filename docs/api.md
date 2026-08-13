# Référence API

> Le moteur expose une API REST complète. La spec OpenAPI vivante est disponible sur `/docs` (Swagger UI) une fois le service démarré.

## Endpoints publics (pas d'authentification)

| Endpoint | Méthode | Description |
|---|---|---|
| `/health` | `GET` | Healthcheck (statut, version GLPI, statut LLM). |
| `/api/status` | `GET` | Métriques engine (polling, whitelist, compteur LLM, cost cap). Le détail — volumétrie, coûts, diagnostic du dernier cycle — est **omis** sans session admin. |

## Endpoints qui exigent une authentification

| Endpoint | Méthode | Description |
|---|---|---|
| `/metrics` | `GET` | **Métriques Prometheus d'infrastructure** (hors `/api`). **Session administrateur requise**, ou `METRICS_TOKEN` — voir ci-dessous. |
| `/api/metrics` | `GET` | KPIs métier agrégés sur 14 jours (à ne pas confondre avec `/metrics`). Session requise. |
| `/api/operational-metrics` | `GET` | Dashboard inversé (équipe, fenêtre glissante 7 j). Session requise. |

> **`/metrics` (Prometheus)** — endpoint d'**infrastructure**, distinct de `/api/metrics`
> (KPI métier). Format exposition Prometheus : `itsm_http_requests_total` (compteur) et
> `itsm_http_request_duration_seconds` (histogramme), labellisés par **route templatée**
> (ex. `/api/decisions/{id}`) — pas de PII ni d'identifiant concret dans les labels.
> Activable via `METRICS_ENABLED` (défaut `true`). **Cet endpoint n'est plus anonyme depuis
> la 0.9.48** : si `METRICS_TOKEN` est défini, il exige `Authorization: Bearer <jeton>` (ou
> `X-Metrics-Token`) ; si `METRICS_TOKEN` est **vide**, il exige une **session administrateur**.
> Un scrape Prometheus anonyme reçoit donc un `401` dans les deux cas : poser `METRICS_TOKEN`
> est la seule façon de le faire fonctionner. Détails : [`docs/install.md`](install.md).

## Authentification (Argon2 + session signée)

Un **seul** compte administrateur, créé **à la première visite** — pas d'amorçage par variable d'environnement.

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/auth/setup` | `POST` | **Création du compte unique** (`email`, `password`, `display_name` optionnel) puis ouverture de session. **Public** — par construction, aucun identifiant n'existe pour l'atteindre — mais **fail-closed** : `409` (`already_configured`) dès qu'un compte existe, `422` sur email invalide ou mot de passe < 8 caractères. |
| `/api/auth/login` | `POST` | Connexion (`email` + `password` → cookie de session). |
| `/api/auth/logout` | `POST` | Déconnexion. |
| `/api/auth/status` | `GET` | État de la session : `authenticated`, `auth_configured`, **`setup_required`** (vrai tant qu'aucun compte n'existe → l'UI envoie sur l'écran de création). |
| `/api/auth/me` | `GET` | Identité du compte connecté (`email`, `display_name`). **Authentifiée** — route séparée précisément pour que `/api/auth/status`, qui est publique, n'ait jamais à porter l'adresse. |
| `/api/auth/password` | `POST` | Change le mot de passe (`current_password`, `new_password`). **Authentifiée**, revérifie le mot de passe courant, et compte ses échecs sur le **même limiteur que le login** — sinon la route offrirait un oracle de vérification non compté. Succès = toutes les sessions tombent, y compris l'appelante (la génération de session est incrémentée) : l'UI renvoie sur `/login`. |

⚠️ **L'adresse du compte n'apparaît dans aucune réponse NON authentifiée.** `/api/auth/status` est public : diffuser l'identifiant à un anonyme lui offrirait la moitié du couple à deviner. De même, un login raté renvoie le **même** code et le **même** message que l'email soit inconnu ou le mot de passe faux — et le hash est payé dans tous les cas, pour que le chronomètre ne dise pas ce que le message tait.

Rate-limit : 5 tentatives / 300 s par IP, blocage 300 s (configurable). Honore `X-Forwarded-For` si `TRUST_PROXY_HEADERS=true`. **`/api/auth/setup` est compté par le même limiteur** que le login : sans cela, la création offrirait un point de martèlement non compté, et un moyen de sonder gratuitement si l'instance est encore revendicable.

> **Fenêtre de revendication (risque assumé)** : tant qu'aucun compte n'existe, `POST /api/auth/setup` est ouvert à quiconque atteint le port. Ni jeton d'amorçage ni fenêtre temporelle — choix délibéré, annoncé par un `WARNING` à chaque démarrage. **N'exposez pas le port avant d'avoir créé le compte** (cf. [`SECURITY.md`](../SECURITY.md) et [`docs/install.md`](install.md)).

## Configuration

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/config` | `GET` | Réglages non-secrets + booléens `*_set` pour les secrets. Inclut le choix d'API (`glpi_api_version` legacy/v2), les deux URL de base (`glpi_base_url`, `glpi_v2_base_url`) et les identifiants OAuth V2 non-secrets. |
| `/api/config` | `POST` | Pousse les réglages (tokens GLPI, clé LLM, **client_secret/mot de passe OAuth V2** chiffrés Fernet au repos). |
| `/api/glpi/sync` | `POST` | Scan GLPI → cache des référentiels (catégories, entités, techniciens, groupes). |
| `/api/glpi/whoami` | `GET` | Compte GLPI sous lequel le bot agit (aperçu UI) : nom, login, profil, email, `has_picture`, API active. |
| `/api/glpi/avatar` | `GET` | Photo de profil du compte bot (proxy GLPI, V2) ; 404 si absente → l'UI affiche des initiales. |
| `/api/glpi/reset` | `POST` | Réinitialise toute la connexion GLPI (URLs, tokens, identifiants OAuth ; retour en mode `legacy`). |

## Périmètre & whitelist curée

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/discovery/{kind}` | `GET` | Liste tout le cache pour `kind ∈ {category, entity, technician, group}`. Chaque entrée porte `updated_at` : l'horodatage du dernier scan **qui a vu cette entrée** (`services/referentials.sync` l'écrit ligne par ligne, uniquement sur les objets rapportés par GLPI). Un objet disparu de GLPI est conservé mais **n'est pas rajeuni** : il garde la date du dernier scan qui l'a vu. La console, elle, n'exploite aujourd'hui que le **maximum** de ces dates (`dernierScan`, `components/SyncButton.tsx`) pour dater la dernière synchro et signaler un cache de plus de 30 jours — elle ne signale pas encore les entrées individuellement en retard. |
| `/api/scope` | `GET` | Périmètre actuel (catégories autorisées + entités). |
| `/api/scope` | `PUT` | Met à jour le périmètre. |
| `/api/modes` | `PUT` | Mode d'exécution par entité (`suggestion`/`semi_auto`/`full_auto`), 2ᵉ seuil semi-auto, et **cible de repli** (`fallback_group_id` / `fallback_technician_id`, groupe prioritaire). Une cible non éligible est refusée (`400 fallback_not_eligible`) plutôt qu'acceptée sans effet. |
| `/api/technicians` | `PUT` | Éligibilité + fiche en prose par technicien. |
| `/api/groups` | `PUT` | Éligibilité + fiche en prose par groupe. |
| `/api/skills` | `GET` | Catalogue des 14 domaines de compétence cochables (contenu produit). |
| `/api/absences` | `GET` | Absences déclarées (technicien, période **incluse**, remplaçant, `active` = couvre aujourd'hui). |
| `/api/absences` | `PUT` | Remplace la liste. Refuse à la saisie : remplaçant non éligible (`replacement_not_eligible`), remplaçant lui-même absent sur la période (`replacement_also_absent`), auto-remplacement, période inversée (`invalid_period`). |
| `/api/skills/coverage` | `GET` | Carte de couverture : par domaine, nombre de techniciens et de groupes **éligibles** qui le couvrent. Cardinalités seulement — aucun acteur n'est nommé (anti-mouchard). |

## Triage & Journal

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/sandbox` | `POST` | Test à blanc d'un texte de ticket (`title` + `content`, aucune écriture GLPI). La réponse porte la Décision LLM **même refusée** (avec son motif) ainsi que `model`, `cost_eur`, `prompt_tokens`, `completion_tokens` — l'essai est facturé et décompté du plafond, il doit donc dire ce qu'il a coûté. |
| `/api/decisions` | `GET` | Journal de décision (`limit`, défaut 500, borné à 10 000 — **pas d'`offset`** : la liste est rendue du plus récent au plus ancien). Chaque entrée porte `fallback_applied`, qui distingue un « à trier » repris par la cible de repli d'un « à trier » resté sans destinataire. |
| `/api/decisions/{id}/annotation` | `PATCH` | Annotation libre a posteriori. |
| `/api/export/decisions.csv` | `GET` | Export CSV DPO du Journal. |
| `/api/export/llm-calls.csv` | `GET` | Export CSV des appels LLM (masqués). |

## Automations RGPD

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/automations/retention` | `GET` | Réglages de rétention (jours conservés, dernière purge). |
| `/api/automations/retention` | `PATCH` | Modifie la rétention (activation, fenêtres, heure UTC). |
| `/api/automations/retention/run` | `POST` | Déclenche une purge manuelle (`confirm: "PURGER"`). |

## Confidentialité (DPO) & coûts

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/privacy` | `GET` | État du masquage PII : catégories + statut effectif par édition, rétentions, nombre d'appels LLM. |
| `/api/privacy/test-mask` | `POST` | Applique le masquage **réel** (état + édition courants) à un texte (`{ "text": "…" }`). |
| `/api/privacy/report.md` | `GET` | Rapport DPO téléchargeable (Markdown) : édition, catégories masquées, rétention. |
| `/api/cost` | `GET` | Dépense LLM 24 h vs plafond journalier glissant, ratio, nombre d'appels et tarifs configurés. |

## Debug (gatés par `DEBUG_TOOLS_ENABLED`)

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/debug/status` | `GET` | Statut runtime étendu. |
| `/api/debug/info` | `GET` | Version, build, environnement. |
| `/api/debug/diagnostics` | `GET` | Sondes GLPI + LLM. |
| `/api/debug/seed` | `POST` | Jeux de test GLPI (labo). |
| `/api/debug/purge-users` | `POST` | Suppression d'utilisateurs locaux (labo). |

⚠️ Désactivé par défaut. À n'activer qu'en labo / homelab.

## Conventions

- **JSON** en `snake_case` anglais.
- **Dates** ISO 8601 UTC.
- **Erreurs** : `{ "code": str, "message": str }`.
- **Réponses** : modèles Pydantic directs (pas de wrapper).

## Voir aussi

- [`docs/architecture.md`](architecture.md) — pipeline et structure interne.
- [`docs/modes.md`](modes.md) — comportement par mode.
