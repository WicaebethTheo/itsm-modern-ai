# Guide de fonctionnement — ITSM Modern AI

**Installation chez le client, fonctionnement du moteur, et activation des fonctions Supporter.**

ITSM Modern AI est un **moteur de triage IA des tickets GLPI**, *on-premise* et souverain.
Principe non négociable : **le LLM propose, le code valide et décide.** Le modèle ne reçoit
jamais les clés de votre GLPI ; chaque action est bornée par du code déterministe.

- **Mono-conteneur** : Python/FastAPI sert l'API **et** l'UI React sur le port `8000`.
- **Aucune dépendance lourde** : base **SQLite** + secrets chiffrés (Fernet) dans le volume `./data`. Pas de Postgres, pas de Redis requis.
- **Open-core (édition unique)** : tout le code est livré dans une **seule image** (MIT) ; une **licence Supporter** (Ed25519 hors-ligne) débloque **en place** des fonctions avancées — **sans réinstallation ni swap d'image**.

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

> **Masquage PII selon la licence :** sans licence, on masque **e-mail + téléphone**. Une
> licence **Supporter** débloque **IBAN/cartes, IP/MAC, secrets (mots de passe/tokens/clés), NIR/SIRET**.

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

## 4. Fonctions Supporter : verrouillé vs actif

Le code des fonctions Supporter est **livré dans l'image unique** (toujours `installed`).
Une fonction est **active** uniquement si **la licence l'autorise** (`entitled`). Sans
licence valide, elle reste verrouillée même si le code est présent —
`active = installed ∧ entitled`.

```mermaid
flowchart TD
    F["Fonction Supporter<br/>(ex. masquage IBAN/secrets)"] --> I{"Code livré ?<br/>(image unique)"}
    I -- oui --> E{"Licence valide<br/>et l'autorise ?"}
    E -- non --> LOCK["🔒 Verrouillée<br/>(« devenez Supporter »)"]
    E -- oui --> ON["🟢 Active"]

    style LOCK fill:#fecaca,stroke:#b91c1c
    style ON fill:#bbf7d0,stroke:#15803d
```

| Capacité | Sans licence (Community) | Avec licence Supporter |
|---|:---:|:---:|
| Triage IA à garde-fous, modes suggestion/semi/full | ✅ | ✅ |
| Masquage PII e-mail + téléphone | ✅ | ✅ |
| Masquage **IBAN/cartes, IP/MAC, secrets, NIR/SIRET** | ❌ | ✅ |
| Vérification licence **hors-ligne** (Ed25519, air-gap) | — | ✅ |

> La licence est un **jeton signé Ed25519**, vérifié **100 % hors-ligne** (aucun appel
> sortant, compatible air-gap). Pas de « phone-home ».

---

## 5. Devenir Supporter (depuis la page Supporter)

Édition unique : pas de second déploiement, **pas de swap d'image**. On garde **la même
image** et **le même `./data`** ; on **colle simplement une clé de licence dans la page
Supporter** de la console. Réversible : retirer la clé sur cette même page revient à Community.

1. Ouvrez la console et allez sur la page **Supporter**.
2. **Collez la clé de licence** (`itsm-lic.v1.…`) et validez.
3. La clé est **vérifiée hors-ligne** (Ed25519). Valide → les fonctions s'activent **en place**.

```mermaid
sequenceDiagram
    actor Op as Opérateur
    participant UI as Page Supporter (console)
    participant Eng as Moteur (vérif Ed25519)
    participant Data as ./data (inchangé)

    Op->>UI: colle la clé de licence
    UI->>Eng: vérifie la licence HORS-LIGNE
    Note over UI,Eng: aucun appel sortant — validation pure
    alt clé invalide
        Eng-->>Op: ❌ refusée (rien n'est stocké, rien ne change)
    else clé valide
        Eng->>Data: stocke la clé (config chiffrée)
        Eng-->>Op: ✅ Supporter actif (fonctions débloquées en place)
    end
```

**Garanties :**
- **Données conservées** : même volume `./data` → aucune reconfiguration, aucun secret à ressaisir.
- **Sûre** : la licence est validée **avant** stockage ; une clé invalide n'est pas enregistrée.
- **Réversible** : retirez la clé sur la page Supporter → re-verrouillage immédiat (retour Community).

> **Pré-amorçage optionnel** : pour livrer une instance déjà licenciée (déploiement
> automatisé), définissez `LICENSE_KEY=itsm-lic.v1.…` dans `.env` avant le premier démarrage.
> La page Supporter reste la méthode normale.

```mermaid
stateDiagram-v2
    [*] --> Community
    Community --> Supporter: coller la clé (page Supporter)<br/>(même image, même ./data)
    Supporter --> Community: retirer la clé (page Supporter)
    note right of Supporter
        Masquage avancé débloqué
        Licence vérifiée hors-ligne
    end note
```

---

## 6. Souveraineté & confidentialité (résumé)

- **Hébergement** : 100 % chez vous (mono-conteneur). Aucun backend éditeur dont vous dépendez.
- **Données** : avec Ollama, le contenu ne quitte **jamais** votre réseau ; avec Mistral, il reste sur une infrastructure **UE**.
- **Masquage PII** appliqué **avant** tout appel LLM (portée selon la licence).
- **Zéro phone-home** par défaut ; vérification de mise à jour **opt-in** ; licence **hors-ligne**.
- **Auditable** : chaque décision est journalisée (entrées masquées, réponse, validation, action).

> ⚠️ Le moteur fournit des **garde-fous**, pas une garantie absolue. La sécurisation du
> déploiement (durcissement de l'hôte, TLS, revue des décisions, choix du fournisseur)
> reste de la responsabilité de l'exploitant.
