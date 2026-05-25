# Installation on-premise (pilote V1)

> Déploiement **pilote** : un seul conteneur Docker, base **SQLite**, **pas de haute disponibilité**.
> Ce n'est **pas** l'architecture de production. Voir la note « durcissement » en fin de page.

## Prérequis

- Une **VM Linux** avec **Docker** et **docker compose** (plugin v2).
- Une instance **GLPI joignable** depuis la VM, avec un **`user_token` API** (auth `apirest.php`, plus un `App-Token` si la config serveur GLPI l'exige).
- Accès réseau sortant vers le **fournisseur LLM** configuré (Mistral EU par défaut).

## 1. Récupérer le projet et créer le `.env`

```bash
cp .env.example .env
```

Le `.env` ne contient **que des réglages non-secrets**, la `MASTER_KEY` de chiffrement et l'URL de base de données. Renseignez :

- **`MASTER_KEY`** — clé Fernet servant à chiffrer les secrets au repos (FR-25). Générez-la :

  ```bash
  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  ```

  Si elle est laissée vide, une clé est générée automatiquement et persistée dans `data/master.key`.

- **`DATABASE_URL`** — par défaut `sqlite:///./data/itsm.db` (la base vit dans le volume monté).

> Les **secrets** (clé API LLM, tokens GLPI) ne se mettent **jamais** dans `.env` : ils se poussent au runtime via l'API (étape 4).

## 2. Monter le fichier des fiches techniciens

Le `docker-compose.yml` monte déjà `docs/tech-profiles.example.yaml` en lecture seule vers `/app/data/tech-profiles.yaml` (FR-15). Copiez l'exemple et adaptez-le à votre équipe avant le démarrage :

```bash
cp docs/tech-profiles.example.yaml docs/tech-profiles.yaml
```

(et pointez le montage du `docker-compose.yml` vers `docs/tech-profiles.yaml` si vous renommez le fichier).

## 3. Démarrer le service

```bash
docker compose up --build
```

Le service écoute sur le port **8000**.

## 4. Configuration RUNTIME via l'API (secrets)

La **clé API LLM (Mistral EU)** et le **token GLPI** se poussent par `POST /api/config` et sont stockés **chiffrés au repos** (Fernet, FR-25). `GET /api/config` ne renvoie jamais la valeur d'un secret, seulement un booléen `*_set`.

```bash
curl -X POST http://localhost:8000/api/config -H 'Content-Type: application/json' -d '{
  "glpi_base_url": "https://glpi.exemple.local/apirest.php",
  "glpi_user_token": "xxxxx",
  "llm_api_key": "yyyyy"
}'
```

## 5. Vérifier

```bash
curl http://localhost:8000/health
```

Le healthcheck est en **échec** si GLPI ou le LLM est injoignable au démarrage (FR-27, FR-1) — pas de démarrage silencieux dégradé.

## 6. HTTPS via reverse proxy (FR-26)

La terminaison **TLS est déléguée à un reverse proxy** (nginx, Caddy, …) placé devant le service sur le port `8000`. Le service ne sert pas TLS lui-même. Configurez le proxy pour **rediriger ou refuser le HTTP nu** et ne servir qu'en HTTPS.

## Sauvegarde

Sauvegardez régulièrement le volume **`./data`** : il contient à la fois la **base SQLite** (`itsm.db`) **et** la **master key** (`data/master.key`).

> ⚠️ Sans la master key, **les secrets chiffrés sont irrécupérables**.

## Note — pilote, pas production

Ce déploiement (SQLite, conteneur unique, pas de HA) est **acceptable en pilote** mais n'est **pas** l'architecture de production. Un plan de durcissement est prévu avant tout déploiement payant (cf. PRD §12).
