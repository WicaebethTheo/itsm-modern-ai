# Architecture

> Vue d'ensemble du fonctionnement du moteur, du pipeline de triage et de la structure hexagonale du code.

## Pourquoi ce produit existe

GLPI gère bien les tickets **structurés** (catégorie cochée, urgence renseignée, demandeur connu). Mais sa file accumule aussi tout le reste — la **« Queue longue »** : « ça marche plus », « le truc bleu », messages en argot, sans champ posé, sans pièce jointe. Ces tickets bloquent la qualité de service plancher : ils restent en attente, sont mal routés, ou répondus en retard.

**ITSM Modern AI** lit les tickets neufs, masque les données sensibles, propose une décision (catégorie, priorité, technicien/groupe, brouillon de réponse) — puis le **code** valide cette proposition contre une **whitelist déterministe** curée par l'admin avant toute action. Le LLM n'a pas la main : il propose, le code décide.

Le produit est conçu pour :

- **DSI françaises de PME** : déploiement on-premise, défaut souverain (Mistral EU), interface FR/EN, validation DPO facile.
- **Migration douce** : commence en mode `suggestion` (Suivi privé, aucune mutation GLPI) → bascule en `semi_auto`/`full_auto` quand la confiance est calibrée.
- **Open-core (édition unique)** : tout le code est MIT et public ; monétisation par le service (support SLA, install/config) et les **licences Supporter** qui déverrouillent en place des features déjà livrées dans l'image.

## Pipeline immuable

L'ADN du produit — l'ordre des étapes n'est **jamais** réordonné, jamais court-circuité :

```
GLPI poll  →  règles déterministes  →  cost cap  →  masquage PII
       (étage 1 — pas d'appel LLM si une règle traite déjà le Ticket)

      LLM (JSON mode, retry)  →  validation Pydantic  →  whitelist  →  seuil de confiance

                              ┌─── Décision valide ──→  Suivi GLPI (mode du périmètre)
                              │
                              └─── tout échec ─────→  « à trier » (fallback unique)
```

**Garanties absolues, tous modes confondus :**

- Aucune écriture GLPI sans validation whitelist + seuil.
- Aucune PII non masquée n'atteint le LLM (email, téléphone, IBAN, mot de passe/token).
- Aucune métrique par technicien (anti-mouchard, RGPD).
- Aucun phone-home (souveraineté).
- Une seule échappatoire : « à trier » — jamais de crash bloquant la file.

## Structure hexagonale

Domain ↔ Ports ↔ Adapters strict — le domaine n'importe aucun adaptateur, les invariants tiennent à la frontière.

```
src/itsm_modern_ai/
├── domain/        cœur : models, engine (whitelist + seuil), masking, prompting
├── ports/         interfaces (Protocol) : ItsmPort, LlmPort, SecretsPort
├── adapters/
│   ├── itsm/glpi/   client apirest.php + mapper (ITILFollowup 9.x/10.x)
│   ├── llm/         Mistral EU · OpenAI · Ollama · Anthropic + mock offline
│   └── secrets/     chiffrement Fernet
├── services/      référentiels (scan + périmètre), runtime_config, triage
├── scheduler/     poller APScheduler (idempotent)
├── persistence/   SQLModel/SQLite, journal, idempotence, UtcDateTime
├── config/        Settings (pydantic-settings) + credentials GLPI
└── api/           FastAPI : routes REST, auth (Argon2), rate-limit, SPA static
frontend/          SPA React 19 + Vite 6 + Tailwind v4 (i18n FR/EN, Biome)
migrations/        Alembic
scripts/           spike_routing.py (Epic 1), diagnostics GLPI
tests/             pytest + respx (unit + integration)
docs/              install, dpo, spike, project-context, architecture, …
```

Le moteur reste **headless** : la SPA React est servie en statique par le moteur (image Docker multi-stage `node:22 → python:3.13`), aucun serveur Node au runtime. Le contrat REST est l'API publique du moteur — CLI/Slack/batch peuvent s'y brancher demain.

## Voir aussi

- [`docs/project-context.md`](project-context.md) — invariants non-négociables (à lire avant de coder).
- [`docs/modes.md`](modes.md) — modes d'exécution par périmètre.
- [`docs/api.md`](api.md) — référence des endpoints.
