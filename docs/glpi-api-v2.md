# Connecteur GLPI API V2 (high-level) — **Beta**

> ⚠️ **Beta — encore tout jeune.** L'API haut-niveau de GLPI 11 (« V2 ») est récente et
> évolue (versions `v2.0`→`v2.3`, quelques endpoints encore instables côté GLPI). Le
> connecteur V2 est fourni **en option** : le connecteur **legacy `apirest.php` reste le
> défaut** et la source de vérité tant que la V2 n'est pas éprouvée en production.
> Bascule par `GLPI_API_VERSION=v2` (voir plus bas).

## Différence mesurée : assignation d'acteur

Les deux connecteurs assignent un acteur, mais **pas par la même primitive** — et cela change
leur comportement au rejeu. Mesuré sur une instance GLPI 11 réelle, sur des tickets de test :

| | Legacy (`apirest.php`) | V2 (`api.php/v2.3`) |
|---|---|---|
| Primitive | `PUT Ticket` (**mise à jour**) | `POST TeamMember` (**insertion**) |
| Acteur déjà assigné | **accepté**, sans doublon | **`400 ERROR_INVALID_PARAMETER`** |
| Conséquence | rien à faire | rattrapage nécessaire (relecture de l'état) |

Le connecteur V2 relit donc l'équipe du ticket quand le `POST` échoue : si l'acteur visé y
figure, l'objectif est atteint. Il ne se fie **pas** au code d'erreur, trop générique pour
distinguer « déjà présent » d'une vraie faute (cf. `assign_actor`).

Ce que les deux partagent, vérifié également : `assign_actor` **ne touche ni la catégorie ni
la priorité** (router, jamais classer), là où `apply_decision` les modifie bien — les deux
contrats sont réellement disjoints des deux côtés.

Ce document décrit le contrat de l'API V2 tel qu'**observé sur une instance GLPI 11.0.7
réelle** (spec OpenAPI `GET /api.php/v2.3/doc.json`, public) et confirmé par la doc
officielle. C'est la base d'implémentation de `adapters/itsm/glpi/v2/`.

---

## 1. Legacy vs V2 — ce qui change

| Aspect | Legacy V1 (`apirest.php`) | **V2 (`api.php/vX`)** |
|---|---|---|
| Point d'entrée | `/apirest.php` | `/api.php` |
| Auth | `initSession` → `Session-Token` (+ `App-Token`) | **OAuth2** (`Authorization: Bearer`) |
| Versionnement | implicite | **dans l'URL** : `/api.php/v2.3/…` |
| Structure | plat par itemtype (`/Ticket`) | **namespacé** (`/Assistance/Ticket`, `/Administration/User`, `/Dropdowns/ITILCategory`) |
| Champs liés | ids à plat (`itilcategories_id`…) | **objets `{id,name}`** en lecture / **id entier** en écriture |
| Acteurs | `_users_id_assign`, `_groups_id_assign` | ressource dédiée **`TeamMember`** (`{type, id, role}`) |
| Mise à jour | `PUT` | **`PATCH`** |
| Recherche | `criteria[...]`, `range=0-49` | **RSQL** (`filter=…`), `start`/`limit`, `sort=champ:dir` |
| Doc | `apirest.php/` (markdown) | **OpenAPI/Swagger** `/api.php/doc` |

---

## 2. Découverte des versions

`GET /api.php/` renvoie l'index des versions. Sur l'instance de référence :

- `v1` (1.0.0) — bas niveau, sans garantie de stabilité.
- **`v2.3` (2.3.0) — stable, recommandée.** Préfixe : `/api.php/v2.3/…`
- `v2.0` / `v2.1` / `v2.2` — dépréciées.

Le routeur GLPI résout `v2` → dernière mineure stable, `v2.3` → dernier patch de 2.3,
`v2.3.0` → version exacte. Le connecteur utilise le préfixe configuré tel quel
(**`GLPI_V2_BASE_URL`** doit pointer sur `…/api.php/v2.3` ; `GLPI_BASE_URL` reste l'URL
legacy `apirest.php`, les deux coexistent).

**Spec OpenAPI de l'instance** (source de vérité par instance) :
`GET https://<glpi>/api.php/doc` (HTML) ou `…/api.php/v2.3/doc.json` (JSON).

---

## 3. OAuth2 (obligatoire)

### 3.1 Créer un client OAuth dans GLPI (prérequis admin)

1. **Configuration → Clients OAuth → Ajouter.**
2. Renseigner *Name*, cocher le grant **« Password Grant »** et les scopes **`api` + `user`**
   (et `email` si tu veux l'email dans l'aperçu). `api` couvre tickets/référentiels ; `user`
   est requis EN PLUS pour `/Administration/User/Me` (aperçu du compte). ⚠️ Si tu **modifies**
   un client OAuth existant, GLPI peut **régénérer le `client_secret`** → re-saisis-le dans l'UI.
3. GLPI génère un **`Client ID`** et un **`Client Secret`** — **le secret n'est affiché
   qu'une fois**, le copier immédiatement.
4. Prérequis serveur : les clés `config/oauth.pem` / `config/oauth.pub` doivent exister
   (générées à l'install de GLPI 11).

> Le grant **`client_credentials` n'est PAS supporté** pour le scope `api` (réservé au
> scope `inventory`). Pour un backend automatisé, on utilise donc le grant **`password`**
> avec un compte technique GLPI dédié (droits minimaux : lecture tickets/référentiels +
> écriture suivi/ticket selon le mode).

### 3.2 Obtenir un jeton — grant `password`

```
POST {GLPI}/api.php/token            (chemin GLOBAL, sans préfixe de version)
Content-Type: application/x-www-form-urlencoded

grant_type=password&client_id=<id>&client_secret=<secret>&username=<compte>&password=<mdp>&scope=api
```

> Le corps est envoyé en **`application/x-www-form-urlencoded`** (standard OAuth2 RFC 6749 §4.3.2,
> le plus portable). GLPI 11 tolère aussi le JSON, mais le connecteur utilise le form-encoded.

Réponse :

```json
{ "token_type": "Bearer", "expires_in": 3600, "access_token": "…" }
```

> Un `refresh_token` n'est garanti que pour le grant `authorization_code`. En grant
> `password` on **ré-authentifie** simplement à l'expiration (`expires_in`). Le connecteur
> met le jeton en cache et le renouvelle avec une marge de sécurité.

### 3.3 Appels API

Tous les appels portent l'en-tête :

```
Authorization: Bearer <access_token>
```

En-têtes contextuels optionnels : `GLPI-Entity`, `GLPI-Profile`,
`GLPI-Entity-Recursive`, `Accept-Language`.

---

## 4. Ressources (chemins exacts, préfixe `/api.php/v2.3`)

### Tickets — namespace `Assistance`
| Opération | Méthode | Chemin |
|---|---|---|
| Lister / rechercher | `GET` | `/Assistance/Ticket` |
| Récupérer par id | `GET` | `/Assistance/Ticket/{id}` |
| Créer | `POST` | `/Assistance/Ticket` |
| **Mettre à jour** | **`PATCH`** | `/Assistance/Ticket/{id}` |
| Supprimer | `DELETE` | `/Assistance/Ticket/{id}` |

### Suivis (ITILFollowup) — sous-item de Timeline
| Opération | Méthode | Chemin |
|---|---|---|
| Créer un suivi | `POST` | `/Assistance/Ticket/{id}/Timeline/Followup` |
| Lister la timeline | `GET` | `/Assistance/Ticket/{id}/Timeline` |
| Get/MAJ/Suppr | `GET`/`PATCH`/`DELETE` | `/Assistance/Ticket/{id}/Timeline/Followup/{sub_id}` |

Corps de création : `{ "content": "<html>", "is_private": true|false }`.
L'item parent est porté par l'URL (pas besoin de `items_id`/`itemtype` dans le corps).

### Acteurs / assignation — ressource `TeamMember`
| Opération | Méthode | Chemin |
|---|---|---|
| Ajouter un acteur | `POST` | `/Assistance/Ticket/{id}/TeamMember` |
| Lister par rôle | `GET` | `/Assistance/Ticket/{id}/TeamMember/{role}` |
| Retirer | `DELETE` | `/Assistance/Ticket/{id}/TeamMember` |

Corps : `{ "type": "User"|"Group"|"Supplier", "id": <int>, "role": "requester"|"assigned"|"observer" }`
→ **technicien assigné** = `{type:"User", role:"assigned"}` ; **groupe assigné** =
`{type:"Group", role:"assigned"}`.

### Référentiels
| Ressource | Méthode | Chemin |
|---|---|---|
| Catégories ITIL | `GET` | `/Dropdowns/ITILCategory` |
| Utilisateurs | `GET` | `/Administration/User` |
| Groupes | `GET` | `/Administration/Group` |
| Entités | `GET` | `/Administration/Entity` |
| Version GLPI | `GET` | `/Setup/Config/core/version` → `{value:"11.0.7"}` (scope `api`) |

> **Parité legacy** : `server_version()` lit `/Setup/Config/core/version` (la version GLPI
> n'est PAS dans `/status`, qui ne renvoie que des états de santé). Le profil affiché par
> technicien provient du `default_profile` de chaque `User` (la V2 n'expose pas la jointure
> multi-profils du legacy).

---

## 5. Schéma `Ticket` (champs utiles)

En **lecture**, les dropdowns reviennent en objet `{id, name}` ; en **écriture** on envoie
l'**id entier**.

| Champ | Lecture | Écriture | Sens |
|---|---|---|---|
| `name` | string | string | titre |
| `content` | string (HTML) | string | description |
| `type` | int | int | 1 = Incident, 2 = Demande |
| `category` | `{id,name}` | **`{"id": int}`** | catégorie ITIL (objet en écriture, `name` readOnly) |
| `urgency` | int 1–5 | int | urgence |
| `impact` | int 1–5 | int | impact |
| `priority` | int 1–5 | int | priorité |
| `status` | `{id,name}` (readOnly) | — | **1 = Nouveau**, 2 = Attribué, 3 = Planifié, 4 = En attente, 5 = Résolu, 6 = Clos |
| `entity` | `{id,name}` | `int` | entité |
| `team` | `[{id,name,type,role}]` | (cf. TeamMember) | acteurs |

`is_new(ticket)` ⇔ `status.id == 1`.

---

## 6. Recherche / filtre / pagination / tri

- **`filter`** — RSQL : `<champ><op><valeur>`, connecteurs `and`/`or`, dot-notation.
  Opérateurs : `==` `!=` `=in=` `=out=` `=lt=` `=le=` `=gt=` `=ge=` `=like=` `=ilike=`
  `=isnull=` `=isnotnull=` `=empty=` `=notempty=`. Ex. : `status==1`.
- **`start`** (défaut `0`) — offset ; **`limit`** (défaut `100`) — taille de page.
- **`sort`** — `champ:asc|desc`, multi séparé par virgules. Ex. : `date_creation:desc`.

Le connecteur récupère les tickets « New » via `filter=status.id==1` + `sort=id:desc` +
`limit=<polling_max_tickets>`. ⚠️ `status` est un **objet imbriqué** `{id,name}` → le filtre RSQL
vise la sous-propriété en **dot-notation** (`status.id`), pas `status` à plat.

---

## 7. Bascule legacy ↔ V2 (config)

| Variable `.env` | Effet |
|---|---|
| `GLPI_API_VERSION=legacy` *(défaut)* | connecteur `apirest.php` (V1) — inchangé |
| `GLPI_API_VERSION=v2` | connecteur **OAuth2 high-level (Beta)** |

Réglages V2 (poussés via l'UI/`POST /api/config`). Dans la console, tout se saisit sur
**Configuration › Connexion GLPI**, après avoir basculé le champ *Version de l'API GLPI* sur V2 :

- **`GLPI_V2_BASE_URL`** — champ *URL de base (api.php/v2.3)* : URL de base V2 dédiée,
  distincte de `GLPI_BASE_URL` (champ *URL de base (apirest.php)*, legacy) ; les deux coexistent.
- **`GLPI_OAUTH_SCOPE`** — champ *Scopes OAuth* (cases à cocher) : scopes demandés, séparés par
  un espace dans la configuration (défaut `api user` ; `api` couvre tickets/référentiels, `user`
  requis pour l'aperçu du compte `User/Me`).
- `GLPI_OAUTH_CLIENT_ID`, `GLPI_OAUTH_USERNAME` — champs *Client ID* et *Identifiant (username)* :
  non-secrets, donc réaffichés tels quels dans l'UI.
- `GLPI_OAUTH_CLIENT_SECRET`, `GLPI_OAUTH_PASSWORD` — champs *Client secret* et *Mot de passe* :
  **secrets chiffrés** Fernet, write-only — l'UI ne les réaffiche jamais, elle signale
  seulement « Déjà configuré — laisser vide pour conserver ».

---

## 8. Conformité vérifiée

Le connecteur a été audité contre le **spec OpenAPI réel** de l'instance (`/api.php/v2.3/doc.json`)
et l'instance live (probes non authentifiés) : les 10 endpoints utilisés existent (401 = présents +
protégés OAuth), et les payloads (token form-urlencoded, `category:{id}`, filtre `status.id==1`,
`TeamMember {type,role,id}`, `Followup {content,is_private}`) sont conformes aux schémas. Reste à
confirmer **avec des identifiants réels** (bout-en-bout) la création de suivi et l'assignation
`TeamMember` — cf. limites ci-dessous.

## 9. Limites connues (Beta)

- **Assignation d'acteurs** via `TeamMember` : opérationnelle mais l'API GLPI 11 a encore
  des bugs ponctuels sur la gestion des acteurs/timeline selon le patch — à valider sur
  l'instance cible avant `full_auto`.
- **Disponibilité de certains `/Dropdowns/…`** variable selon la révision 11.0.x.
- **Pas de `refresh_token`** garanti en grant `password` → ré-auth à l'expiration.
- Le contrat exact d'une instance fait foi : `GET /api.php/doc.json`.

## Voir aussi
- [`docs/llm-providers.md`](llm-providers.md) · [`docs/architecture.md`](architecture.md)
- Help Center GLPI — [RESTful API (V2)](https://help.glpi-project.org/documentation/modules/configuration/general/api/restful-api-v2)
- Help Center GLPI — [OAuth Clients](https://help.glpi-project.org/documentation/modules/configuration/oauth-clients)
