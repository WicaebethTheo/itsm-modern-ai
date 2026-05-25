# ITSM Modern AI — moteur de triage GLPI à garde-fous

Assistant IA de triage de tickets pour **GLPI** : application autonome **on-premise** qui
classe, priorise, route et propose une réponse pour les tickets que les règles GLPI ne
savent pas traiter (la « Queue longue »), **toujours derrière un garde-fou déterministe**.
Open-core, souverain (Mistral EU par défaut), français.

> **Invariant produit :** le LLM **propose**, le code **valide et décide** (whitelist
> déterministe). Mode suggestion uniquement (jamais de modification d'un champ GLPI),
> masquage PII avant tout appel LLM, fallback unique « à trier ».

## État du projet : Epic 1 (spike de validation, gate Phase 0)

Le développement suit une **discipline de séquençage** stricte :

```
Epic 1 (spike) → [GO/NO-GO humain] → Epic 2 → Epic 3 → Epic 4
```

Ce dépôt contient **l'Epic 1** (`planning/epics.md`) : le spike technique qui mesure si le
**routage par fiches en prose** + la **précision LLM sur tickets FR mal formulés** tiennent.
Le GO dépend aussi d'un travail terrain (interviews DSI) **hors code**. Les Epics 2→4 ne
sont **pas** implémentés tant que le GO n'est pas confirmé.

Le code du spike est **réutilisable, pas jetable** : il est déjà rangé aux emplacements
hexagonaux définitifs (`domain/`, `ports/`, `adapters/`, `services/`), que l'Epic 2+ étendra.

## Démarrage rapide

```bash
make install          # crée le venv (uv) + installe les deps
make lint             # ruff
make test             # pytest (chemins critiques : masquage, whitelist, parsing JSON)
make spike-mock       # exécute le spike OFFLINE (mock déterministe, plomberie seulement)

# Exécution réelle du spike (vraie mesure) — nécessite une clé Mistral EU :
cp .env.example .env  # puis renseigner LLM_API_KEY
make spike
```

Le spike écrit `spike-report.md` + `spike-report.json` (justesse, couverture utile, seuil
de confiance suggéré, cas d'échec, verdict go/no-go). Voir [`docs/spike.md`](docs/spike.md).

## Structure (hexagonale)

```
src/itsm_modern_ai/
├── domain/      # cœur : models, engine (whitelist+seuil), masking, prompting — AUCUN adaptateur
├── ports/       # interfaces (Protocol) : LlmPort
├── adapters/    # llm/ (OpenAI-compatible défaut Mistral, + mock offline)
├── services/    # tech_profiles (fiches en prose)
└── config/      # pydantic-settings (.env)
scripts/spike_routing.py        # SPIKE Epic 1
tests/                          # unit + integration (respx), fixtures/tickets_fr.json
planning/                       # PRD, architecture, epics, addendum (specs)
```

## Documentation

- [`planning/`](planning/) — PRD, architecture, epics, addendum (les specs).
- [`project-context.md`](project-context.md) — règles & invariants pour tout agent.
- [`docs/spike.md`](docs/spike.md) — comment lire/exécuter le spike.
- [`docs/handoff.md`](docs/handoff.md) — note de passation d'origine.

## Stack

Python 3.12+, Pydantic v2 + pydantic-settings, httpx, PyYAML. Tests : pytest + respx.
Lint : ruff. Gestion deps : uv. (FastAPI/SQLModel/APScheduler/Docker arrivent à l'Epic 2+.)

## Licence

MIT (cf. `LICENSE`).
