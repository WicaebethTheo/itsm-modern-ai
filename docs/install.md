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

## 2. Démarrer le service

```bash
docker compose up --build
```

L'image est construite en **multi-stage** (build de la SPA React avec Node, puis moteur
Python qui la sert en statique). Le service écoute sur le port **8000**. Rien d'autre à
monter : la base SQLite et la master key vivent dans le volume `./data`.

## 3. Tout configurer dans l'interface web

Ouvrez l'**interface** sur **`http://<vm>:8000/`** (derrière le reverse proxy HTTPS en prod).
Connectez-vous avec le mot de passe `ADMIN_PASSWORD` (si défini). Toute la configuration se
fait ici — **aucun fichier à éditer** :

- **Connexion GLPI** : base URL `apirest.php`, **user token** (et app token si requis).
- **Fournisseur IA** : choisissez parmi **Mistral EU** (souverain, défaut), **OpenAI** (hors UE — à valider DPO), **Ollama** (modèle **local**, **pas de clé**) ou **Anthropic / Claude** (hors UE — à valider DPO) ; saisir la **clé API** (sauf Ollama).
- **Moteur** : seuil de confiance et cost cap.
- **Périmètre (scan GLPI puis sélection)** : lancez le **scan GLPI** (`POST /api/glpi/sync`) pour mettre en cache catégories, entités, techniciens et groupes, puis **sélectionnez** ce que l'IA a le droit d'utiliser — **catégories autorisées + entités** du périmètre, **techniciens/groupes éligibles** et leur **fiche en prose** (routage). Le moteur n'agit que dans ce périmètre effectif. **Plus de fichier YAML** : les fiches sont éditées dans l'UI et stockées en base.

Les **secrets** (clé LLM, tokens GLPI ; pas de clé pour Ollama) sont stockés **chiffrés au repos** (Fernet, FR-25) et ne sont **jamais** réaffichés ni mis dans `.env`.

> Équivalent en ligne de commande (l'UI consomme ce même endpoint `POST /api/config`) :
>
> ```bash
> curl -X POST http://localhost:8000/api/config -H 'Content-Type: application/json' -d '{
>   "glpi_base_url": "https://glpi.exemple.local/apirest.php",
>   "glpi_user_token": "xxxxx",
>   "llm_provider": "anthropic",
>   "anthropic_api_key": "sk-ant-…"
> }'
> ```

## 4. Vérifier

```bash
curl http://localhost:8000/health
```

Le healthcheck est en **échec** si GLPI ou le LLM est injoignable au démarrage (FR-27, FR-1) — pas de démarrage silencieux dégradé.

**Diagnostic GLPI dédié** (recommandé à l'install — valide auth, référentiels, lecture
des tickets, et optionnellement l'écriture d'un Suivi privé) — identifiants via
l'environnement, **jamais en dur** :

```bash
GLPI_BASE_URL="https://glpi.exemple.local/apirest.php" \
GLPI_USER_TOKEN="…" GLPI_APP_TOKEN="…" \
  make glpi-diagnose        # lecture seule
# test d'écriture d'un Suivi privé sur un ticket de test :
#   uv run python scripts/glpi_diagnose.py --write-test <ticket_id>
```

> ✅ Intégration validée sur GLPI 10/11 (apirest.php) : `initSession`, `ITILCategory`,
> `User`/`Profile`/`Profile_User`, `Group`, `Entity`, lecture des Tickets et écriture d'un
> `ITILFollowup` **privé** sans mutation de champ (mode suggestion).

## 5. HTTPS via reverse proxy (FR-26)

La terminaison **TLS est déléguée à un reverse proxy** (nginx, Caddy, …) placé devant le service sur le port `8000`. Le service ne sert pas TLS lui-même. Configurez le proxy pour **rediriger ou refuser le HTTP nu** et ne servir qu'en HTTPS.

## Sauvegarde

Sauvegardez régulièrement le volume **`./data`** : il contient à la fois la **base SQLite** (`itsm.db`) **et** la **master key** (`data/master.key`).

> ⚠️ Sans la master key, **les secrets chiffrés sont irrécupérables**.

## Note — pilote, pas production

Ce déploiement (SQLite, conteneur unique, pas de HA) est **acceptable en pilote** mais n'est **pas** l'architecture de production. Un plan de durcissement est prévu avant tout déploiement payant (cf. PRD §12).
