# Guide de fonctionnement — ITSM Modern AI

**Installation chez le client, fonctionnement du moteur, et passage en édition Enterprise.**

ITSM Modern AI est un **moteur de triage IA des tickets GLPI**, *on-premise* et souverain.
Principe non négociable : **le LLM propose, le code valide et décide.** Le modèle ne reçoit
jamais les clés de votre GLPI ; chaque action est bornée par du code déterministe.

- **Mono-conteneur** : Python/FastAPI sert l'API **et** l'UI React sur le port `8000`.
- **Aucune dépendance lourde** : base **SQLite** + secrets chiffrés (Fernet) dans le volume `./data`. Pas de Postgres, pas de Redis requis.
- **Open-core** : édition **Community** (gratuite, MIT) ; édition **Enterprise** (licence Ed25519 hors-ligne) qui débloque des fonctions avancées — **sans réinstallation**.

---

## 1. Architecture d'ensemble

```mermaid
flowchart LR
    U["👤 Opérateur ITSM<br/>(navigateur)"] -->|HTTPS| RP["Reverse proxy + TLS<br/>(nginx / Caddy / Traefik)"]
    RP -->|"HTTP 127.0.0.1:8000"| C

    subgraph C["Conteneur ITSM Modern AI (port 8000)"]
        API["FastAPI<br/>API + SPA React"]
        SCH["Planificateur<br/>(polling)"]
        DB[("SQLite + secrets<br/>chiffrés Fernet")]
        API --- DB
        SCH --- DB
    end

    SCH <-->|"API REST<br/>(App+User-Token / OAuth2)"| GLPI["🎫 GLPI<br/>(votre instance)"]
    SCH -->|"texte masqué (PII)"| LLM["🧠 Fournisseur LLM<br/>Mistral EU · OpenAI · Anthropic · Ollama (local)"]

    V[("Volume ./data<br/>(persistant)")] -.-> DB
```

**À retenir :**
- Le conteneur n'est **jamais** exposé directement : on le place derrière un reverse proxy qui termine le TLS (le conteneur écoute en loopback / réseau privé).
- Les secrets (tokens GLPI, clé API LLM) sont saisis **dans la console**, jamais dans `.env`, et stockés **chiffrés** dans `./data`.
- Avec **Ollama**, aucune donnée ne quitte votre réseau.

---

## 2. Le pipeline de triage (ordre immuable)

Pour chaque ticket nouveau ou mis à jour, le moteur exécute **toujours** la même séquence.
Le LLM n'intervient qu'au milieu, et sa sortie est **revalidée par du code**.

```mermaid
flowchart TD
    A["Ticket GLPI<br/>(nouveau / mis à jour)"] --> B{"Règles GLPI<br/>déjà appliquées ?"}
    B -- oui --> Z["⏭️ Ignoré"]
    B -- non --> C{"Plafond de coût<br/>du jour atteint ?"}
    C -- oui --> T["⚠️ « À trier »<br/>(repli sûr, aucune action)"]
    C -- non --> D["🛡️ Masquage PII<br/>(AVANT tout appel LLM)"]
    D --> E["🧠 Appel LLM<br/>(mode JSON + retry)"]
    E --> F{"Réponse JSON<br/>valide ?"}
    F -- non --> T
    F -- oui --> G{"Cible dans la<br/>liste blanche ?"}
    G -- non --> T
    G -- oui --> H{"Confiance ≥ seuil ?"}
    H -- non --> T
    H -- oui --> M{"Mode de l'entité ?"}
    M -- suggestion --> S["📝 Suivi interne PRIVÉ<br/>(brouillon, aucun champ modifié)"]
    M -- semi_auto --> H2{"Confiance ≥<br/>2ᵉ seuil ?"}
    H2 -- non --> S
    H2 -- oui --> P
    M -- full_auto --> P["✅ Champs GLPI appliqués<br/>+ réponse PUBLIQUE au demandeur"]

    style T fill:#fde68a,stroke:#b45309
    style S fill:#bfdbfe,stroke:#1d4ed8
    style P fill:#bbf7d0,stroke:#15803d
```

**Garde-fous (le « code décide ») :**
- **Liste blanche déterministe** : une cible hors de l'ensemble autorisé est rejetée → « à trier ».
- **Seuil de confiance** : sous le seuil, rien n'est appliqué.
- **« À trier »** est la **seule** échappatoire : en cas de doute, le moteur ne fait rien de risqué.
- Le brouillon LLM est **échappé (HTML)** et **re-masqué** avant toute publication publique.

> **Masquage PII selon l'édition :** Community masque **e-mail + téléphone**. L'édition
> Enterprise débloque **IBAN/cartes, IP/MAC, secrets (mots de passe/tokens/clés), NIR/SIRET**.

---

## 3. Installation chez le client

### Pré-requis
- **Docker Engine** + **Compose v2** (`docker compose version`).
- Une instance **GLPI** joignable (API REST legacy `apirest.php` activée, ou API V2 OAuth2 en Beta).
- Une clé **Mistral** (défaut souverain UE), une autre clé cloud supportée, **ou** **Ollama** local.
- ~1 Go de disque libre.

### Procédure (voie recommandée : `install.sh`)

```bash
git clone https://github.com/tmeneboode/itsm-modern-ai.git
cd itsm-modern-ai
./install.sh          # préflight + .env + build + démarrage + mot de passe admin
```

```mermaid
sequenceDiagram
    actor Op as Opérateur
    participant Sh as install.sh
    participant Dk as Docker Compose
    participant Ct as Conteneur ITSM
    participant Data as ./data

    Op->>Sh: ./install.sh
    Sh->>Sh: préflight (docker, ports, RAM)
    Sh->>Sh: cp .env.example .env + chmod 600
    Sh->>Dk: docker compose up -d --build
    Dk->>Ct: démarre le mono-conteneur
    Ct->>Data: génère MASTER_KEY (1er démarrage)
    Sh->>Op: demande le mot de passe admin (saisie masquée)
    Op-->>Sh: mot de passe
    Sh->>Ct: admin_setup → stocke un hash Argon2 (jamais en clair)
    Sh->>Ct: health check (HTTP 200)
    Sh-->>Op: ✅ console prête sur http://<hôte>:8000
```

**Points de sécurité importants :**
- `MASTER_KEY` est **générée au premier démarrage dans `./data`** (ne pas la mettre dans `.env` en pilote ; en production, on peut la gérer hors-bande).
- Le mot de passe admin est saisi de façon interactive et stocké en **hash Argon2**. **Fail-closed** : sans identifiant configuré, les endpoints admin répondent **401** (jamais ouverts).
- `install.sh` pose `chmod 600` sur `.env`.

### Configuration depuis la console (étape humaine, une fois)

```mermaid
flowchart LR
    L["🔑 Connexion admin"] --> G["1️⃣ Page GLPI<br/>URL + App/User-Token<br/>(ou OAuth2 V2)"]
    G --> P["2️⃣ Page Fournisseur<br/>Mistral / OpenAI / Anthropic / Ollama"]
    P --> E["3️⃣ Page Moteur<br/>liste blanche · seuil · plafond coût · masquage"]
    E --> M["4️⃣ Mode = suggestion<br/>(défaut sûr)"]
    M --> R["▶️ 1er cycle :<br/>lire le Journal des décisions"]
```

> **Démarrer sans risque :** restez en mode **suggestion** (aucune écriture, suivi privé)
> tant que vous n'avez pas relu assez de décisions pour faire confiance. Pour un essai
> sans **aucune** écriture GLPI, utilisez le **Bac à sable** (`/api/sandbox`).

### Mise en production
- Toujours derrière un **reverse proxy + TLS** (le conteneur n'est pas exposé en direct).
- Sauvegarder le volume **`./data`** (config, journal, secrets chiffrés) **et** `MASTER_KEY` séparément. *Perdre `MASTER_KEY` ou `./data` = secrets irrécupérables.*
- Mise à jour : `./update.sh` (sauvegarde `./data` d'abord) ou `git pull && docker compose up -d --build`.

---

## 4. Éditions : Community vs Enterprise

Une fonction payante est **active** uniquement si **(1) son code est présent** (image Enterprise)
**ET (2) la licence l'autorise**. Sur l'image Community, le code n'est pas là → tout reste
verrouillé même avec une clé valide.

```mermaid
flowchart TD
    F["Fonction Enterprise<br/>(ex. masquage IBAN/secrets)"] --> I{"Code installé ?<br/>(image Enterprise)"}
    I -- non --> LOCK["🔒 Verrouillée<br/>(« passez Enterprise »)"]
    I -- oui --> E{"Licence valide<br/>et l'autorise ?"}
    E -- non --> LOCK
    E -- oui --> ON["🟢 Active"]

    style LOCK fill:#fecaca,stroke:#b91c1c
    style ON fill:#bbf7d0,stroke:#15803d
```

| Capacité | Community | Enterprise |
|---|:---:|:---:|
| Triage IA à garde-fous, modes suggestion/semi/full | ✅ | ✅ |
| Masquage PII e-mail + téléphone | ✅ | ✅ |
| Masquage **IBAN/cartes, IP/MAC, secrets, NIR/SIRET** | ❌ | ✅ |
| Vérification licence **hors-ligne** (Ed25519, air-gap) | — | ✅ |

> La licence est un **jeton signé Ed25519**, vérifié **100 % hors-ligne** (aucun appel
> sortant, compatible air-gap). Pas de « phone-home ».

---

## 5. Passage en Enterprise (sans réinstallation)

Le modèle open-core ne crée **pas** un second déploiement : on garde **le même `./data`**
et on **remplace l'image**. La bascule est réversible.

```bash
# 1) Récupérer l'image Enterprise (registre privé, ou archive hors-ligne)
#    puis, dans le dossier du déploiement :
./upgrade-to-enterprise.sh "<clé-de-licence>"
#    variante air-gap : ./upgrade-to-enterprise.sh "<clé>" image.tar
```

```mermaid
sequenceDiagram
    actor Op as Opérateur
    participant Sh as upgrade-to-enterprise.sh
    participant Ent as Image Enterprise
    participant Env as .env
    participant Dk as Docker Compose
    participant Data as ./data (inchangé)

    Op->>Sh: ./upgrade-to-enterprise.sh "<clé>"
    Sh->>Ent: vérifie la licence HORS-LIGNE (Ed25519)
    Note over Sh,Ent: aucune I/O sur ./data — validation pure
    alt clé invalide
        Sh-->>Op: ❌ bascule annulée (rien n'a changé)
    else clé valide
        Sh->>Env: ITSM_IMAGE=…enterprise + LICENSE_KEY=<clé>
        Sh->>Dk: docker compose up -d (même volume ./data)
        Dk->>Data: réutilise config, journal, secrets
        Sh->>Dk: health check
        Sh-->>Op: ✅ Enterprise actif (fonctions débloquées)
    end
```

**Garanties de la bascule :**
- **Données conservées** : même volume `./data` → aucune reconfiguration, aucun secret à ressaisir.
- **Sûre** : la licence est validée **avant** tout changement ; une clé invalide annule la bascule sans rien modifier.
- **Réversible** : retour à Community à tout moment —

  ```bash
  ./upgrade-to-enterprise.sh --rollback   # remet ITSM_IMAGE / LICENSE_KEY à vide
  ```

```mermaid
stateDiagram-v2
    [*] --> Community
    Community --> Enterprise: upgrade-to-enterprise.sh "<clé>"<br/>(swap image, même ./data)
    Enterprise --> Community: --rollback
    note right of Enterprise
        Masquage avancé débloqué
        Licence vérifiée hors-ligne
    end note
```

---

## 6. Souveraineté & confidentialité (résumé)

- **Hébergement** : 100 % chez vous (mono-conteneur). Aucun backend éditeur dont vous dépendez.
- **Données** : avec Ollama, le contenu ne quitte **jamais** votre réseau ; avec Mistral, il reste sur une infrastructure **UE**.
- **Masquage PII** appliqué **avant** tout appel LLM (portée selon l'édition).
- **Zéro phone-home** par défaut ; vérification de mise à jour **opt-in** ; licence **hors-ligne**.
- **Auditable** : chaque décision est journalisée (entrées masquées, réponse, validation, action).

> ⚠️ Le moteur fournit des **garde-fous**, pas une garantie absolue. La sécurisation du
> déploiement (durcissement de l'hôte, TLS, revue des décisions, choix du fournisseur)
> reste de la responsabilité de l'exploitant.
