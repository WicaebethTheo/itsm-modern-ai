# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/) ; le projet ne suit
pas SemVer strictement (version d'app dans `pyproject.toml`, actuellement `0.7.0`).

Les entrées les plus récentes sont en haut.

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
