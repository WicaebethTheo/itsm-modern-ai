<div align="center">

<img src="frontend/public/favicon.svg" width="80" alt="ITSM Modern AI" />

# ITSM Modern AI

**Moteur de triage IA des tickets GLPI — souverain, à garde-fous, on-premise.**

*The LLM proposes, the code decides — GLPI ticket triage with deterministic guardrails.*

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.9.2-blueviolet)](pyproject.toml)
[![Python 3.13+](https://img.shields.io/badge/Python-3.13+-3776AB?logo=python&logoColor=white)](pyproject.toml)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-38B2AC?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![Tests](https://img.shields.io/badge/tests-316_pytest_%C2%B7_71_vitest-success)](https://docs.itsm-modern-ai.com)
[![Sovereign](https://img.shields.io/badge/sovereign-Mistral_EU_default-6B46C1)](https://docs.itsm-modern-ai.com)

[Démarrage rapide](#démarrage-rapide) · [Documentation](https://docs.itsm-modern-ai.com) · [Site](https://itsm-modern-ai.com)

</div>

---

## En une phrase

GLPI gère bien les tickets structurés. **ITSM Modern AI** prend en charge le reste — la « Queue longue » : tickets flous, mal formulés, sans champ posé. Le LLM propose, le **code valide et décide** (whitelist déterministe, masquage PII avant tout appel LLM, fallback unique « à trier »). On-premise, souverain (Mistral EU par défaut), open-core MIT.

➜ **[Documentation complète](https://docs.itsm-modern-ai.com)** · **[Site produit](https://itsm-modern-ai.com)**

---

## Démarrage rapide

### Avec Docker (recommandé, on-prem)

```bash
# En une ligne (clone GitHub + install) :
curl -fsSL https://itsm-modern-ai.com/install | sh

# Ou manuellement :
git clone https://github.com/WicaebethTheo/itsm-modern-ai.git
cd itsm-modern-ai
./install.sh                     # vérifie les prérequis, démarre, demande un mot de passe admin
./install.sh --bundle itsm.tar.gz   # install hors-ligne depuis une image (air-gap)
open http://localhost:8000       # console web (SPA React)
```

`install.sh` **vérifie les prérequis** (Docker, plugin compose, disque, port) et **propose
de les installer** (installation de Docker via le script officiel, plugin compose via le
binaire officiel — toutes distros), applique les migrations, démarre le service et crée le
compte administrateur (mot de passe saisi à l'écran, stocké **uniquement en hash Argon2
chiffré**), puis affiche une **checklist** de l'état du système. Changer le mot de passe :
`./install.sh --reset-password`.

<details><summary>Install manuelle (équivalent)</summary>

```bash
cp .env.example .env                                    # MASTER_KEY auto-générée dans ./data
docker compose up -d --build                            # build + démarre (migrations incluses)
docker compose exec itsm python -m itsm_modern_ai.admin_setup   # mot de passe admin (masqué)
```
</details>

> ⚠️ **Ne JAMAIS faire `docker compose down -v`** : `-v` supprime le volume `./data`
> qui contient la base SQLite + la `master.key` Fernet. La configuration repart à zéro.

**Mise à jour** — **une seule commande** : relancez l'installeur (`./install.sh`, ou le one-liner `curl … | sh`). S'il détecte une instance existante, il propose un menu **Mettre à jour / Réinstaller**. La mise à jour **sauvegarde `./data` d'abord** (pg_dump / copie SQLite), récupère la dernière version, reconstruit et applique les migrations — données préservées. *(Non-interactif : `./install.sh --update`.)*

Détails : **[docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)**.

Tout se configure ensuite **dans l'interface** : connexion GLPI, choix du fournisseur LLM, scan GLPI, sélection des catégories/entités/techniciens/groupes du périmètre, fiches en prose, modes par entité. **Aucun secret dans `.env`** — les tokens GLPI et clés LLM sont poussés via l'UI et chiffrés Fernet au repos.

### Développement local

```bash
make install     # venv (uv) + deps Python
make migrate     # alembic upgrade head
make ui          # build SPA (requiert Node 22)
make run         # uvicorn + scheduler → http://localhost:8000

# Frontend hot-reload (proxy /api → :8000) :
make ui-dev      # http://localhost:5173
```

Détail des suites de tests et conventions qualité : **[documentation en ligne](https://docs.itsm-modern-ai.com)**.

---

## Stack

| Couche | Technologies |
|---|---|
| **Backend** | Python 3.13+, FastAPI, SQLModel (SQLite → Postgres-ready), Alembic, Pydantic v2, APScheduler, cryptography (Fernet), httpx |
| **Frontend** | React 19, Vite 6, Tailwind v4, React Router 7, i18n FR/EN |
| **Qualité** | ruff, Biome, pytest + respx, Vitest + Testing Library, Playwright |
| **Infra** | Docker multi-stage, docker-compose, conteneur non-root, volume `./data` |

---

## Sécurité & RGPD

- **On-premise**, aucun phone-home, aucun appel sortant hors fournisseur LLM configuré.
- **Secrets chiffrés Fernet** au repos ; `master.key` montée comme volume Docker (`0600`).
- **Masquage PII avant le LLM** : e-mail + téléphone toujours inclus ; IBAN/cartes, secrets (mots de passe/tokens/clés API), IP/MAC et identifiants FR (NIR/SIRET) débloqués par une licence **Supporter**. ⚠️ Sans licence, IBAN et secrets sont envoyés **en clair** au LLM (avertissement affiché dans la console + fiche DPO).
- **Console DPO** dédiée (page *Confidentialité (DPO)*) : tableau des catégories PII masquées, outil de test du masquage, et **export d'un rapport DPO** (Markdown) — pour valider le flux de données en réunion.
- **Page Coûts & quotas** : dépense LLM des dernières 24 h vs plafond journalier glissant.
- **Pas de métrique nominative** par technicien (anti-mouchard).
- **Conteneur non-root**, rate-limit login (avec `X-Forwarded-For` derrière proxy).
- **Export CSV DPO** + rétention RGPD automatisée.

Détails : **[Sécurité & limites](https://docs.itsm-modern-ai.com/security-limits/)** · **[documentation en ligne](https://docs.itsm-modern-ai.com)**.

---

## Documentation

📖 **Toute la documentation est en ligne : [docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com)**

Installation on-prem, architecture (pipeline immuable), connecteurs GLPI (legacy + API V2), fournisseurs LLM & souveraineté, portage PostgreSQL, modes d'exécution, fiche DPO/RGPD, référence API, et guide **[Supporter](https://docs.itsm-modern-ai.com/supporter/)**.

Site produit : **[itsm-modern-ai.com](https://itsm-modern-ai.com)**.

---

## Éditions (open-core)

Édition **UNIQUE** : un seul dépôt, une seule image. Tout le code est livré ici (MIT) — triage à garde-fous, connecteurs GLPI **legacy + V2**, PostgreSQL, masquage PII **e-mail + téléphone**, modes par entité — **plus** les fonctionnalités **Supporter** (leur code est présent mais **verrouillé**).

Les features **Supporter** se déverrouillent **en place** par une **clé de licence signée (Ed25519, vérifiée hors-ligne — zéro phone-home, compatible air-gap)** : masquage **IBAN/cartes + secrets (mots de passe/tokens/clés API) + IP/MAC** et identifiants FR **NIR/SIRET**. *(Patterns regex personnalisés, multi-entités avancé et exports planifiés / DPO+ : sur la roadmap.)* Elles apparaissent dans la console (page **Supporter**) mais restent **verrouillées** tant qu'aucune licence valide n'est fournie. La clé de **signature** reste dans le dépôt privé de signature des licences ; seule la clé publique de vérification est embarquée.

**Devenir Supporter** sans rien perdre (même `./data`, aucun swap d'image) : **coller la clé de licence dans la page Supporter** de la console — elle déverrouille les features en place. Pour désactiver, **retirer la clé sur cette même page** (retour à Community). `LICENSE_KEY` dans `.env` reste un pré-amorçage optionnel pour les déploiements automatisés. Détails : **[docs.itsm-modern-ai.com/supporter](https://docs.itsm-modern-ai.com/supporter/)**.

## Licence

[MIT](LICENSE) — open-core, monétisation par le service (support SLA, install/config, prestations, licences Supporter). Tout le code applicatif est public dans ce dépôt ; seule la clé privée de signature des licences reste hors dépôt.

---

<div align="center">

Conçu pour les DSI qui veulent **garder la main** : le LLM propose, le code décide.

</div>
