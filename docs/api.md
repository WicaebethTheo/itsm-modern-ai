# Référence API

> Le moteur expose une API REST complète. La spec OpenAPI vivante est disponible sur `/docs` (Swagger UI) une fois le service démarré.

## Endpoints publics (pas d'authentification)

| Endpoint | Méthode | Description |
|---|---|---|
| `/health` | `GET` | Healthcheck (statut, version GLPI, statut LLM). |
| `/metrics` | `GET` | **Métriques Prometheus d'infrastructure** (hors `/api`) : volumétrie + latence HTTP par route templatée. Voir ci-dessous. |
| `/api/status` | `GET` | Métriques engine (polling, whitelist, compteur LLM, cost cap). |
| `/api/metrics` | `GET` | KPIs métier agrégés sur 14 jours (à ne pas confondre avec `/metrics`). |
| `/api/operational-metrics` | `GET` | Dashboard inversé (équipe, fenêtre glissante 7 j). |

> **`/metrics` (Prometheus)** — endpoint d'**infrastructure**, distinct de `/api/metrics`
> (KPI métier). Format exposition Prometheus : `itsm_http_requests_total` (compteur) et
> `itsm_http_request_duration_seconds` (histogramme), labellisés par **route templatée**
> (ex. `/api/decisions/{id}`) — pas de PII ni d'identifiant concret dans les labels.
> Activable via `METRICS_ENABLED` (défaut `true`). Si `METRICS_TOKEN` est défini, l'endpoint
> exige `Authorization: Bearer <jeton>` (ou `X-Metrics-Token`), sinon `401` ; vide = scrape
> non authentifié (rétrocompatible). Détails : [`docs/install.md`](install.md).

## Authentification (Argon2 + session signée)

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/auth/login` | `POST` | Connexion (mot de passe → cookie de session). |
| `/api/auth/logout` | `POST` | Déconnexion. |
| `/api/auth/status` | `GET` | État de la session (authentifié ? auth configurée ?). |

Rate-limit : 5 tentatives / 600 s par IP, blocage 300 s (configurable). Honore `X-Forwarded-For` si `TRUST_PROXY_HEADERS=true`.

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
| `/api/discovery/{kind}` | `GET` | Liste tout le cache pour `kind ∈ {category, entity, technician, group}`. |
| `/api/scope` | `GET` | Périmètre actuel (catégories autorisées + entités). |
| `/api/scope` | `PUT` | Met à jour le périmètre. |
| `/api/modes` | `PUT` | Mode d'exécution par entité (`suggestion`/`semi_auto`/`full_auto`). |
| `/api/technicians` | `PUT` | Éligibilité + fiche en prose par technicien. |
| `/api/groups` | `PUT` | Éligibilité + fiche en prose par groupe. |

## Triage & Journal

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/sandbox` | `POST` | Test à blanc d'un texte de ticket (aucune écriture GLPI). |
| `/api/decisions` | `GET` | Journal de décision paginé (`limit`, `offset`). |
| `/api/decisions/{id}/annotation` | `PATCH` | Annotation libre a posteriori. |
| `/api/export/decisions.csv` | `GET` | Export CSV DPO du Journal. |
| `/api/export/llm-calls.csv` | `GET` | Export CSV des appels LLM (masqués). |

## Automations RGPD

| Endpoint | Méthode | Description |
|---|---|---|
| `/api/automations/retention` | `GET` | Réglages de rétention (jours conservés, dernière purge). |
| `/api/automations/retention` | `PATCH` | Modifie la rétention (activation, fenêtres, heure UTC). |
| `/api/automations/retention/run` | `POST` | Déclenche une purge manuelle (`confirm: "PURGER"`). |

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
