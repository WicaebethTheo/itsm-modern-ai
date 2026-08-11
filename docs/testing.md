# Tests & qualité

> Les chemins critiques (pipeline, masquage, whitelist, cost cap, modes) sont **non-négociables** — couverts par des tests unitaires et d'intégration.

| Suite | Compte | Commande |
|---|---:|---|
| **pytest** (unit + integration via `respx`) | **555** | `make test` |
| **Vitest + Testing Library** (composants + pages) | **153** (22 fichiers) | `make ui-test` |
| **Playwright** (E2E, API mockée) | **3 parcours** | `make ui-e2e` |
| **ruff** (Python) | 0 violation | `make lint` |
| **Biome + tsc** (TS/JSX) | 0 violation | `make ui-lint` |

## Chemins critiques couverts

- Pipeline à ordre immuable (règles → cost cap → masquage → LLM → Pydantic → whitelist → seuil → Suivi / « à trier »).
- Sauvegarde : copie à chaud vérifiée, WAL embarqué, `master.key` jointe, refus explicite sur PostgreSQL, aucun dossier laissé à moitié fait en cas d'échec.
- Fenêtre de doublon du poller : réservation posée AVANT le handler, rendue si le triage est rejouable, libérée en fin de cycle ; une interruption n'est jamais rejouée et est signalée.
- Purge RGPD côté console : confirmation obligatoire **avant** toute suppression, annulation qui n'exécute rien, fenêtres réellement appliquées annoncées dans la confirmation (et non le brouillon non enregistré), échec remonté à l'admin.
- Suivi « non tranché » sur « à trier » : déposé sur un refus **arbitré** (dans les 3 modes, sans mutation, sans brouillon), **jamais** sur un motif rejouable (panne LLM, sortie invalide, cap) ; un GLPI en panne ne casse ni la journalisation ni le marquage « traité ».
- Congés : bornes incluses, sortie du périmètre effectif, expiration automatique, héritage des domaines par le remplaçant, un seul saut d'intérim (ni chaîne ni cycle), fuseau local, purge RGPD des seules absences terminées.
- Repli assigné sur un refus arbitré : route sans classer (aucun champ de triage), jamais en mode `suggestion`, groupe préféré au technicien, cible revalidée contre la whitelist à l'écriture, échec de repli non dégradant, `fallback_applied` distinct de `applied`.
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

**GitHub Actions** (`.github/workflows/`) — GitHub est le seul forge de ce projet.

| Workflow | Déclencheur | Contenu |
|---|---|---|
| `ci.yml` | chaque **PR** + push `main` | `backend` (ruff + pytest sur **3.14 et 3.13**) · `migrations` (Alembic : base vide, base **peuplée**, aller-retour `downgrade`/`upgrade`) · `frontend` (Biome + tsc + Vitest + build Vite) · `docker-build` (image amd64, sans push) |
| `docker-publish.yml` | push `main` → `edge` ; **release** → `latest` + semver | Re-joue ruff + pytest, **smoke test** du conteneur (boot, `/health`, `/api/status`, amorçage admin), puis build multi-arch amd64 + arm64 |
| `release.yml` | tag `v*.*.*` | Crée la release GitHub (c'est elle qui notifie les instances déployées) |
| `codeql.yml` | PR + push `main` + hebdo | Analyse statique de sécurité |
| `secret-scan.yml` | PR + push `main` + hebdo | gitleaks (dont l'historique complet, en hebdo) |
| `security-audit.yml` | hebdo + PR touchant un lockfile | `pip-audit` + `npm audit` |

> **`main` ne déplace plus `latest`** (0.9.54). `latest` — ce que tire tout `docker compose pull` —
> ne bouge que sur une **release publiée**. Un merge dans `main` produit `edge` + `sha-<court>` :
> publier redevient un acte explicite. Qui veut suivre la pointe tire `:edge` en connaissance de cause.

### Couverture

Deux portes, en **cliquet** : elles empêchent l'érosion, elles ne prétendent pas que la
couverture soit suffisante.

| Suite | Mesure | Seuil | Commande |
|---|---:|---:|---|
| Backend | **88,0 %** de *branches* (90,0 % de lignes) | 85 % | `pytest --cov` |
| Frontend | **72,1 %** de *statements*, 62,6 % de branches | 65 / 56 / 65 | `npm run test:coverage` |

Deux choix de configuration qui font toute la différence :

- **Backend : `branch = true`.** Un `if` dont un seul côté est exercé compte comme couvert
  en mesure de lignes — or c'est là que se cachent les régressions (un garde-fou dont on ne
  teste jamais le refus).
- **Frontend : `coverage.include` explicite.** Par défaut Vitest ne mesure que les fichiers
  *chargés* par un test : un fichier sans test sort du **dénominateur** au lieu de compter
  pour 0. Écart mesuré : **81,6 % annoncé contre 69,0 % réel**. Un taux qui *monte* quand on
  supprime un test est pire que pas de taux du tout.

`Dashboard.tsx` et `Debug.tsx` restent non testés — assumé : affichage en lecture seule pour
le premier, outil désactivé par défaut en production (`DEBUG_TOOLS_ENABLED`) pour le second.
L'effort a été mis sur `Automations.tsx`, seul écran déclenchant une **suppression
définitive** de données (purge RGPD).

**E2E Playwright** : joués **en local** (`make ui-e2e`), pas en CI — ils y étaient déjà
non bloquants (`allow_failure`). À rebrancher dans `ci.yml` le jour où ils sont stabilisés.

## Outils

- **uv** pour la gestion des dépendances Python (rapide, déterministe).
- **respx** pour mocker les appels HTTP GLPI et LLM dans les tests.
- **Testing Library** pour les tests React (oriented user behavior).
- **Playwright** pour les E2E (3 parcours : login → dashboard, navigation → journal, login → sandbox).

## Voir aussi

- [`docs/architecture.md`](architecture.md) — ce qui est testé et pourquoi.
- [`docs/project-context.md`](project-context.md) — invariants à préserver.
