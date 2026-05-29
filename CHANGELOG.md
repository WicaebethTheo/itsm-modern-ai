# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/) ; le projet ne suit
pas SemVer strictement (version d'app dans `pyproject.toml`, actuellement `0.7.0`).

Les entrées les plus récentes sont en haut.

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
