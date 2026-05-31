# Fiche DPO — ITSM Modern AI (pilote V1)

> Document destiné à la DPO / au RSSI pour valider le flux de données en une réunion (FR-21, PRD §10).
> Objectif : décrire **honnêtement** le traitement, sans sur-promettre.

## Promesse exacte

**Coordonnées masquées avant l'appel LLM — la portée DÉPEND DE L'ÉDITION.** Ce **n'est pas**
une « anonymisation ». Lisez attentivement le périmètre par édition ci-dessous.

## Portée du masquage (à lire attentivement)

Le masquage (FR-14) repose sur des **expressions régulières** (heuristiques) et **diffère selon
l'édition** (open-core) :

**Édition Community (gratuite)** — masque uniquement :
- adresses **email** → `[EMAIL]` ;
- numéros de **téléphone** (FR et international E.164) → `[PHONE]`.

> ⚠️ **En Community, les IBAN, cartes bancaires, IP/MAC, mots de passe / tokens / clés API
> NE sont PAS masqués** : ils sont transmis **EN CLAIR** au LLM **et** conservés en clair dans
> le journal des appels (table `llm_calls`). **À porter explicitement à la connaissance de la
> DPO** avant toute mise en production avec des données réelles.

**Édition Enterprise (licence)** — ajoute le masquage de :
- **IBAN** → `[IBAN]`, **cartes bancaires** (validation Luhn) → `[CARD]` ;
- **adresses IP** (IPv4) / **MAC** → `[IP]` / `[MAC]` ;
- **mots de passe / tokens** et **clés cloud** (AWS `AKIA…`, Google `AIza…`) → `[SECRET]` / `[CLOUD_KEY]` ;
- identifiants FR **NIR / SIRET** → `[NIR]` / `[SIRET]` et **patterns regex personnalisés**.

> En modes `semi_auto`/`full_auto`, le **brouillon généré par le LLM est re-masqué** (selon
> l'édition) avant toute publication publique au demandeur.

Dans **toutes** les éditions, le masquage **NE masque PAS** les **noms de personnes** ni les
**adresses postales** (reconnaissance d'entités nommées non implémentée). Des données
nominatives peuvent donc apparaître en clair dans le contenu transmis au LLM. La promesse est
« coordonnées masquées selon l'édition », **pas** « aucune donnée nominative ».

## Résidence des données

- Fournisseur LLM par défaut : **Mistral EU**, sous **DPA**, **pas de Cloud Act**. Aucun transfert hors UE par défaut.
- Quatre fournisseurs sont sélectionnables depuis l'interface :
  - **Mistral EU** — souverain (UE), défaut recommandé.
  - ⚠️ **OpenAI** — **hors UE / non-souverain**.
  - ⚠️ **Anthropic (Claude)** — **hors UE / non-souverain**.
  - **Ollama** — modèle **100 % local** sur l'infra du client : **aucune donnée ne sort** (pas de clé API, pas de transfert).
- ⚠️ **OpenAI et Anthropic sont hors UE** : s'ils sont activés, le contenu masqué des tickets est transmis hors UE. À **valider explicitement** avec la DPO avant activation ; le défaut souverain reste Mistral EU.
- Toute l'application tourne **on-premise** sur l'infrastructure du client.
- **Aucun appel sortant** hors du fournisseur LLM configuré. **Aucun phone-home.**
- **Périmètre d'action restreint par l'admin** : l'IA n'utilise que les **catégories, techniciens, groupes et entités explicitement sélectionnés** par l'admin (Whitelist curée depuis un scan GLPI). Tout objet hors de ce périmètre est ignoré (Ticket « à trier »).

## Minimisation

Le masquage intervient **avant** tout appel LLM (ordre du pipeline immuable). Seul le contenu masqué quitte l'infrastructure du client, à destination du seul fournisseur LLM configuré.

## Console DPO (page dédiée)

La console expose une page **« Confidentialité (DPO) »** (`/privacy`, sous l'auth locale) qui
permet de vérifier en réunion, **sans lire le code**, ce qui est réellement masqué :

- **Tableau des catégories PII** avec leur statut **effectif selon l'édition installée**
  (email + téléphone *Actif (Community)* ; IBAN/cartes, secrets/tokens/clés API, IP/MAC,
  NIR/SIRET et patterns regex *Verrouillé · Enterprise* en édition Community). Le statut est
  lu depuis le moteur, pas codé en dur — il reflète l'image **et** la licence actives.
- **Avertissement honnête** affiché en Community : les catégories verrouillées transitent et
  sont journalisées **en clair** (à valider explicitement avant toute donnée réelle).
- **Outil « Tester le masquage »** : colle un texte d'exemple, l'API applique le masquage
  **réel** (état + édition courants) et renvoie le texte masqué — utile pour démontrer que
  `[EMAIL]` est masqué mais qu'un IBAN reste en clair en Community.
- **Rappel des durées de rétention** et **lien vers le journal `llm_calls`**.
- **Export d'un rapport DPO** (`GET /api/privacy/report.md`) : un Markdown daté listant
  l'édition, les catégories masquées et les fenêtres de rétention — pièce jointe pour le dossier.

> Une page **« Coûts & quotas »** (`/cost`) complète l'observabilité : dépense LLM des
> dernières 24 h vs plafond journalier, nombre d'appels et tarifs configurés.

## Traçabilité

- **Log exhaustif des appels LLM** (FR-19) : ticket, horodatage, modèle, contenu envoyé et reçu. Le contenu loggé **reflète toujours le masquage** — aucun secret en clair dans les logs.
- **Journal de décision** (FR-20) : ticket, décision, catégorie, confiance, horodatage, lien GLPI.
- **Export CSV** (FR-21) pour l'audit :
  - `GET /api/export/decisions.csv` — journal de décision ;
  - `GET /api/export/llm-calls.csv` — logs des appels LLM.

## Sécurité

- **Secrets chiffrés au repos** via Fernet (FR-25) — aucun secret en clair en base, dans `.env` ou dans les logs.
- **Authentification locale** requise pour les fonctions d'administration et d'export (FR-24).
- **HTTPS** via reverse proxy (FR-26).

## Anti-mouchard

Par conception (PRD §9.4) :

- **aucune métrique nominative** de performance par technicien ;
- **aucun enregistrement d'un rejet humain** (FR-18, FR-21) — ignorer une suggestion n'est ni tracé ni reproché.

## Rétention

Une **purge RGPD automatique** est implémentée (`services/retention.py`). Elle supprime définitivement, en base locale, les lignes plus anciennes que des fenêtres de conservation **configurables** :

- **Journal de décision** : `retention_decisions_days` (défaut **365 jours**) ;
- **Appels LLM** (masqués) : `retention_llm_calls_days` (défaut **90 jours**).

Une fenêtre **`<= 0` désactive** la purge de la table concernée (défaut sûr : on ne supprime jamais sans réglage explicite).

**Job planifié.** Lorsque `automation_purge_enabled` est actif (défaut `true`), un job quotidien s'exécute à `automation_purge_hour_utc` (défaut **03:00 UTC**), planifié par le scheduler de l'application. La durée et l'heure peuvent être modifiées à chaud via l'UI (le job est re-planifié sans redémarrage).

**Pilotage & audit.** Les endpoints `/api/automations/retention` (authentifiés) permettent de :

- `GET` — consulter l'état (fenêtres, activation, heure, dernière exécution et volumes supprimés) ;
- `PATCH` — ajuster les fenêtres, l'activation et l'heure ;
- `POST /retention/run` — déclencher une purge **manuelle immédiate** (garde-fou de confirmation, comme toute action destructive).

Chaque exécution consigne la dernière purge dans la configuration runtime (`automation_purge_last_run_at`, volumes supprimés) et son initiateur (`automation_purge_last_run_by` : `scheduler` pour l'automatique, l'IP/session de l'admin pour un déclenchement manuel), pour traçabilité RGPD.

Les durées par défaut restent à confirmer avec le client selon ses obligations légales, mais le mécanisme de purge lui-même est livré et actif.
