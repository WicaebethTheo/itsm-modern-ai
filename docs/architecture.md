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
                                                       │
                                   refus ARBITRÉ ──────┤→  Suivi PRIVÉ « non tranché »
                                   (whitelist / seuil) │    + repli assigné (hors suggestion)
                                                       │    — aucun champ de triage posé
                                                       │
                                   triage pas eu lieu ─┘→  rien, Ticket rejoué au cycle suivant
                                   (panne LLM, cap)
```

**Garanties absolues, tous modes confondus :**

- Aucune **mutation de champ** GLPI sans validation whitelist + seuil. *(Formulation précisée en 0.9.50 : un Ticket refusé reçoit désormais un Suivi PRIVÉ « non tranché », qui n'écrit aucun champ — il informe, il n'applique pas. La barrière porte sur `ItsmPort.apply_decision`, pas sur `write_followup`.)*
- Aucune PII non masquée n'atteint le LLM (email, téléphone, IBAN, mot de passe/token).
- Aucune métrique par technicien (anti-mouchard, RGPD).
- Aucun appel sortant depuis le pipeline hors du fournisseur LLM configuré et du GLPI (souveraineté). Seule sortie supplémentaire du moteur, hors pipeline : la vérification de version (activée par défaut, déclenchée par un admin authentifié, lecture seule du dernier numéro publié, aucune donnée envoyée) — `UPDATE_CHECK_URL=` vide la coupe.
- Une seule échappatoire : « à trier » — jamais de crash bloquant la file.

## Structure hexagonale

Domain ↔ Ports ↔ Adapters strict — le domaine n'importe aucun adaptateur, les invariants tiennent à la frontière.

```
src/itsm_modern_ai/
├── domain/        cœur : models, engine (whitelist + seuil), masking, prompting
├── ports/         interfaces (Protocol) : ItsmPort, LlmPort, SecretsPort
├── adapters/
│   ├── itsm/glpi/   client apirest.php + mapper (ITILFollowup 9.x/10.x)
│   ├── itsm/glpi/v2/ API GLPI V2 OAuth2 (Beta) — même ItsmPort
│   ├── llm/         Mistral EU · OpenAI · Ollama · Anthropic + mock offline
│   └── secrets/     chiffrement Fernet
├── services/      référentiels (scan + périmètre), runtime_config, triage
├── scheduler/     poller APScheduler (idempotent)
├── persistence/   SQLModel/PostgreSQL (psycopg 3), journal, idempotence, UtcDateTime
├── config/        Settings (pydantic-settings) + credentials GLPI
└── api/           FastAPI : routes REST, auth (Argon2), rate-limit, SPA static
frontend/          SPA React 19 + Vite 6 + Tailwind v4 (i18n FR/EN, Biome)
migrations/        Alembic
scripts/           spike_routing.py (Epic 1), diagnostics GLPI
tests/             pytest + respx (unit + integration)
docs/              install, dpo, spike, project-context, architecture, …
```

Le moteur reste **headless** : la SPA React est servie en statique par le moteur (image Docker multi-stage `node:24 → python:3.14`), aucun serveur Node au runtime. Le contrat REST est l'API publique du moteur — CLI/Slack/batch peuvent s'y brancher demain.

## Persistance et topologie de déploiement

**PostgreSQL est la seule base supportée** : le driver `psycopg` est une dépendance principale,
`Settings.database_url` vaut `postgresql+psycopg://…`, et le moteur ne démarre pas sans serveur
joignable. La stack livrée compte donc **deux services** — le moteur et sa base
`postgres:17-alpine` — sur un réseau privé, la base ne publiant **aucun port**.

- **Deux volumes, deux rôles.** `itsm_data` (`/app/data`) porte la `master.key` et les
  sauvegardes ; le PGDATA vit à part (`itsm_pgdata`, ou le bind `./data/postgres` depuis les
  sources). Ils sont séparés parce que l'entrypoint du moteur fait un `chown` du volume
  applicatif et que PostgreSQL refuse de démarrer si son PGDATA ne lui appartient pas.
- **Ordre de démarrage.** Les composes posent `depends_on: condition: service_healthy` ; en
  complément, l'entrypoint **attend la base de façon bornée** avant `alembic upgrade head` — ce
  filet couvre `docker run`, Swarm/k8s et une base externe qui redémarre.
- **Alembic est la source de vérité** du schéma ; les migrations s'appliquent au démarrage.
- **Sauvegarde** = `pg_dump --format=custom` **plus** la `master.key`, l'archive étant relue en
  deux temps (structure puis données recomptées). Détail : [`docs/postgresql.md`](postgresql.md).

## Voir aussi

- [`docs/project-context.md`](project-context.md) — invariants non-négociables (à lire avant de coder).
- [`docs/modes.md`](modes.md) — modes d'exécution par périmètre.
- [`docs/api.md`](api.md) — référence des endpoints.
- [`docs/postgresql.md`](postgresql.md) — la base : câblage, variables, majeure épinglée, base externe.
