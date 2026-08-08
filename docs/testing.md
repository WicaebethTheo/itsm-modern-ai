# Tests & qualité

> Les chemins critiques (pipeline, masquage, whitelist, cost cap, modes) sont **non-négociables** — couverts par des tests unitaires et d'intégration.

| Suite | Compte | Commande |
|---|---:|---|
| **pytest** (unit + integration via `respx`) | **492** | `make test` |
| **Vitest + Testing Library** (composants + pages) | **111** (20 fichiers) | `make ui-test` |
| **Playwright** (E2E, API mockée) | **3 parcours** | `make ui-e2e` |
| **ruff** (Python) | 0 violation | `make lint` |
| **Biome + tsc** (TS/JSX) | 0 violation | `make ui-lint` |

## Chemins critiques couverts

- Pipeline à ordre immuable (règles → cost cap → masquage → LLM → Pydantic → whitelist → seuil → Suivi / « à trier »).
- Masquage PII (email, téléphone, IBAN, mot de passe/token).
- Whitelist (catégorie/priorité/technicien/groupe hors périmètre → « à trier »).
- Seuil de confiance + 2ᵉ seuil strict pour `semi_auto`.
- Cost cap glissant (cap atteint → tickets suivants en « à trier »).
- 3 modes d'exécution (`suggestion` jamais de mutation ; `full_auto` mute + Suivi public ; `semi_auto` mute si confiance ≥ 2ᵉ seuil).
- Mode par entité (override du défaut global).
- Idempotence du polling (Ticket déjà traité jamais retraité).
- Secrets Fernet chiffrés au repos + jamais en clair en log.
- Rate-limit login (anti brute-force + support `X-Forwarded-For`).
- Rétention RGPD (purge périodique du Journal et des appels LLM).
- TypeDecorator `UtcDateTime` (colonnes `ts` timezone-aware pour le portage Postgres).

## CI

**GitLab** (`.gitlab-ci.yml`) — pipeline exécutée à chaque push :

| Stage | Jobs |
|---|---|
| `lint` | `backend:lint` (ruff) · `frontend:lint` (Biome + tsc) |
| `test` | `backend:test` (pytest) · `backend:migrations` (alembic upgrade head) · `frontend:test` (Vitest) · `frontend:e2e` (Playwright, `allow_failure: true`) |
| `build` | `frontend:build` (Vite production) · `package:image` (image Docker) |
| `security` | `security:deps-python` (`pip-audit`) · `security:deps-frontend` (`npm audit`) |

**GitHub** (`.github/workflows/`) — `ci.yml` (ruff + pytest, Biome + tsc + Vitest + build Vite,
build de l'image amd64 sans push) et `docker-publish.yml` (publication de l'image GHCR
multi-arch amd64 + arm64).

## Outils

- **uv** pour la gestion des dépendances Python (rapide, déterministe).
- **respx** pour mocker les appels HTTP GLPI et LLM dans les tests.
- **Testing Library** pour les tests React (oriented user behavior).
- **Playwright** pour les E2E (3 parcours : login → dashboard, navigation → journal, login → sandbox).

## Voir aussi

- [`docs/architecture.md`](architecture.md) — ce qui est testé et pourquoi.
- [`docs/project-context.md`](project-context.md) — invariants à préserver.
