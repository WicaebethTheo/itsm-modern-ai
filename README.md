<div align="center">

<img src="frontend/public/favicon.svg" width="84" alt="ITSM Modern AI" />

# ITSM Modern AI

**Triage automatique des tickets GLPI par un LLM, sous contrôle déterministe du code.**
On-premise, souverain, open-core — le modèle propose, le code décide.

*Automated GLPI ticket triage with an LLM kept behind deterministic guardrails.*

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.9.85-blueviolet)](pyproject.toml)
[![GHCR image](https://img.shields.io/badge/GHCR-image_publique-2496ED?logo=github&logoColor=white)](https://github.com/WicaebethTheo/itsm-modern-ai/pkgs/container/itsm-modern-ai)
[![Python 3.13+](https://img.shields.io/badge/Python-3.13+-3776AB?logo=python&logoColor=white)](pyproject.toml)

[Démarrage](#démarrage) · [Fonctionnement](#fonctionnement) · [Documentation](https://docs.itsm-modern-ai.com) · [Site produit](https://itsm-modern-ai.com)

</div>

![Tableau de bord](.github/assets/dashboard.webp)

## Le problème

GLPI traite bien les tickets structurés : les règles métier suffisent quand la catégorie et
le demandeur sont posés. Reste la queue longue — tickets flous, mal formulés, sans champ
exploitable — qui atterrit dans une file « à trier » que personne ne vide.

ITSM Modern AI prend cette file en charge. Un LLM lit le ticket et propose une décision ;
le code la valide contre une liste blanche et un seuil de confiance avant toute écriture
dans GLPI. Le LLM ne décide jamais seul, et un ticket sur lequel le doute subsiste retourne
« à trier » — c'est la seule échappatoire du pipeline.

Le moteur tourne chez vous. Hors du fournisseur LLM que vous configurez et de votre GLPI,
la seule sortie réseau est la vérification de version, désactivable.

## Fonctionnement

```text
 GLPI ──poll──▶ Masquage PII ──▶ LLM (proposition) ──▶ Validation déterministe ──▶ GLPI
                                                       │ whitelist + seuil de confiance
                                                       ▼
                                       sous le seuil / hors liste ─▶ « à trier »
```

L'ordre de ce pipeline n'est jamais réordonné ni court-circuité : aucune action n'atteint
GLPI sans être passée par la validation du code. Les données personnelles sont masquées
avant l'appel au LLM, chaque décision est tracée dans un journal d'audit, et la dépense LLM
est plafonnée par un cost cap glissant sur 24 heures.

## Fonctionnalités

- **Triage à garde-fous** — proposition du LLM filtrée par liste blanche et seuil de
  confiance, repli « à trier ».
- **Connecteurs GLPI** — API *legacy* (`apirest.php`) et API V2 (OAuth2).
- **Choix du fournisseur LLM** — Mistral EU par défaut, OpenAI, Anthropic, ou Ollama en
  local intégral.
- **Masquage des données personnelles** — email et téléphone toujours masqués avant le LLM ;
  catégories étendues sous licence Supporter.
- **Console DPO** — catalogue des catégories masquées, testeur de masquage, export d'un
  rapport DPO en Markdown.
- **Coûts et quotas** — dépense LLM glissante sur 24 heures face au plafond journalier.
- **Multi-entités** — mode de triage réglable par entité GLPI.
- **Persistance PostgreSQL** — livrée comme service de la stack, avec sauvegarde à chaud
  vérifiée et migrations Alembic appliquées au démarrage.
- **Sécurité par défaut** — conteneur non-root, accès administrateur *fail-closed*,
  limitation de débit sur le login, secrets chiffrés au repos.

## Démarrage

Image publique GHCR multi-arch (amd64 + arm64), *pull-only* : ni clone, ni build.

```bash
curl -fsSL https://itsm-modern-ai.com/install | bash
```

Pour Portainer ou un orchestrateur, [`docker-compose.portainer.yml`](docker-compose.portainer.yml)
se colle tel quel : deux services, le moteur et sa base PostgreSQL, aucune variable
obligatoire. La console écoute ensuite sur `http://HOTE:8000`.

| Tag | Contenu | Usage |
|---|---|---|
| `latest` | dernière version publiée (release) | recommandé |
| `X.Y.Z` / `X.Y` | version figée | épinglage |
| `edge` | état intégré de `main`, entre deux releases | lab uniquement |

`latest` ne bouge que sur une release : un merge dans `main` ne change rien pour vous.

Mise à jour : `docker compose pull && docker compose up -d`, les migrations sont appliquées
au démarrage. Sauvegardez d'abord — `docker compose exec itsm python -m itsm_modern_ai.backup`
prend un `pg_dump` à chaud, le relit intégralement et y joint la `master.key`.

> **Jamais `docker compose down -v`.** L'option `-v` supprime le volume de la clé de
> chiffrement et celui des données.

### Première visite

Aucun mot de passe n'est à préparer : le premier écran crée le compte administrateur unique
(email + mot de passe). Le hash Argon2 est chiffré dans le volume.

> **N'exposez pas le port avant d'avoir créé ce compte.** Entre le démarrage du conteneur et
> cette création, quiconque atteint le port peut revendiquer l'administration de l'instance.
> L'absence de jeton d'amorçage et de fenêtre temporelle est un choix délibéré : le prix
> aurait été un secret à transporter, ce que cette version supprime précisément. Tant
> qu'aucun compte n'existe, le moteur le répète à chaque démarrage dans ses logs
> (`AUCUN COMPTE ADMINISTRATEUR : cette instance est REVENDICABLE`).

Il n'existe aucune réinitialisation par email — le produit ne parle à aucun serveur SMTP. La
reprise en main se fait depuis l'hôte, `admin_setup --force` :
[perte d'accès administrateur](https://docs.itsm-modern-ai.com/troubleshooting/).

Toutes les variables d'environnement sont optionnelles ; les clés LLM et les jetons GLPI se
saisissent dans l'interface, chiffrés au repos, jamais dans un fichier.
[Référence de configuration](https://docs.itsm-modern-ai.com/configuration/) ·
[Déploiement en production](https://docs.itsm-modern-ai.com/production-deployment/)
(`docker run` durci, air-gap, build local via [`install.sh`](install.sh)).

## Captures

Toute instance sert un **mode démo** sur `/demo` : mêmes écrans, données entièrement
simulées, aucun GLPI ni clé LLM requis. Les captures ci-dessous en sortent
([`frontend/scripts/screenshots.mjs`](frontend/scripts/screenshots.mjs)).

**Journal des décisions** — chaque décision tracée, avec son motif de repli quand elle n'a
pas été appliquée.

![Journal des décisions](.github/assets/journal.webp)

**Confidentialité (DPO)** — ce qui est masqué avant l'appel au modèle, et ce qui ne l'est pas.

![Console DPO](.github/assets/confidentialite.webp)

**Statut** — ce que l'instance fait réellement : dernier cycle mesuré, état des services dont
elle dépend.

![Statut du moteur](.github/assets/statut.webp)

## Sécurité et souveraineté

**Sorties réseau.** Hors du fournisseur LLM configuré et de votre GLPI, la seule sortie est
la vérification de version : best-effort, elle lit uniquement le dernier numéro publié sur
`api.github.com` et n'envoie aucune donnée de l'instance. `UPDATE_CHECK_URL=` vide la
désactive. La licence Supporter est vérifiée hors-ligne (Ed25519), sans serveur de licence.

**Masquage.** Email et téléphone sont masqués avant l'appel au LLM. IBAN et cartes, secrets
(mots de passe, jetons, clés d'API), IP et MAC, identifiants NIR / SIRET sont débloqués par
une licence Supporter — **sans licence, ils partent en clair au LLM**, ce que la console et
le rapport DPO affichent l'un comme l'autre plutôt que de le taire.

**Secrets et accès.** Chiffrement Fernet au repos, `master.key` en `0600` dans son volume ;
conteneur non-root, administration *fail-closed*, limitation de débit sur le login. Aucune
métrique nominative par technicien : le produit ne mesure pas les personnes. Export CSV pour
la DPO et purge RGPD automatisée.

Détail et limites connues : [Sécurité & limites](https://docs.itsm-modern-ai.com/security-limits/).

## Éditions

Édition unique : un seul dépôt, une seule image, tout le code sous licence MIT — y compris
les fonctions Supporter, dont le code est livré mais verrouillé. Elles se déverrouillent en
place, par une clé signée en Ed25519 vérifiée hors-ligne : collez-la dans la page Supporter
de la console, sans changement d'image ni perte de données. La retirer revient à l'édition
Community.

[docs.itsm-modern-ai.com/supporter](https://docs.itsm-modern-ai.com/supporter/)

## Développement

Backend Python 3.13+ (FastAPI, SQLModel, Alembic, PostgreSQL 17), frontend React 19 + Vite +
Tailwind v4, servi en statique par le moteur — aucun Node au runtime. Un PostgreSQL joignable
est nécessaire, pour lancer le moteur comme pour lancer les tests.

```bash
docker run -d --name itsm-test-pg -p 55432:5432 \
  -e POSTGRES_USER=itsm -e POSTGRES_PASSWORD=itsm -e POSTGRES_DB=itsm postgres:17-alpine

make install     # venv (uv) + dépendances Python
make migrate     # alembic upgrade head
make ui          # build de la SPA (Node 24)
make run         # uvicorn + scheduler → http://localhost:8000
make test        # pytest (TEST_DATABASE_URL, défaut localhost:55432)
make ui-dev      # frontend en hot-reload (proxy /api → :8000)
```

## Aide

- **Bug, régression, question d'usage** — [ouvrir une issue](https://github.com/WicaebethTheo/itsm-modern-ai/issues)
- **Panne en production** — [dépannage](https://docs.itsm-modern-ai.com/troubleshooting/) puis
  la page **Développement** de la console, qui rend un diagnostic copiable à joindre à l'issue.
- **Documentation** — [docs.itsm-modern-ai.com](https://docs.itsm-modern-ai.com) : déploiement,
  architecture, connecteurs GLPI, fournisseurs LLM, exploitation PostgreSQL, modes
  d'exécution, fiche DPO, référence de l'API.

## Licence

[MIT](LICENSE). Le modèle est open-core : tout le code applicatif est public dans ce dépôt,
la monétisation passe par le service — support avec SLA, installation et configuration,
prestations, licences Supporter. Seule la clé privée de signature des licences reste hors
dépôt.
