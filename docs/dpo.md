# Fiche DPO — ITSM Modern AI (pilote V1)

> Document destiné à la DPO / au RSSI pour valider le flux de données en une réunion (FR-21, PRD §10).
> Objectif : décrire **honnêtement** le traitement, sans sur-promettre.

## Promesse exacte

**Secrets et coordonnées masqués + traçabilité complète.**
Ce **n'est pas** une « anonymisation ». Voir la portée du masquage ci-dessous.

## Portée du masquage (à lire attentivement)

Avant **tout** appel au LLM, le système masque dans le contenu du ticket (FR-14) :

- adresses **email** → `[EMAIL]` ;
- numéros de **téléphone** (FR **et international E.164**, durcissement audit 2026-05) → `[PHONE]` ;
- **IBAN** → `[IBAN]` ;
- **cartes bancaires** (16 chiffres, **validation Luhn** anti faux positifs) → `[CARD]` ;
- **adresses IP** (IPv4) et **adresses MAC** → `[IP]` / `[MAC]` ;
- **mots de passe / tokens** (motifs) et **clés cloud** (AWS `AKIA…`, Google `AIza…`) → `[SECRET]` / `[CLOUD_KEY]`.

> Les motifs **CB / IP / MAC / téléphone international / clés cloud** ont été ajoutés lors du durcissement **audit 2026-05** (`domain/masking.py`). De plus, en modes `semi_auto`/`full_auto`, le **brouillon généré par le LLM est re-masqué** avant toute publication publique au demandeur.

Le masquage repose sur des **expressions régulières** (heuristiques). En V1, il **NE masque PAS** :

- les **noms de personnes** ;
- les **adresses** postales.

La reconnaissance d'entités nommées (NER) qui couvrirait noms et adresses est prévue en **V2**. Des données nominatives peuvent donc apparaître en clair dans le contenu transmis au LLM (ex. le nom d'un agent cité dans un ticket). À communiquer tel quel : la promesse est « secrets et coordonnées masqués », **pas** « aucune donnée nominative ».

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
