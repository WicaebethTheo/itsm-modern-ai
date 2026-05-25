# Fiche DPO — ITSM Modern AI (pilote V1)

> Document destiné à la DPO / au RSSI pour valider le flux de données en une réunion (FR-21, PRD §10).
> Objectif : décrire **honnêtement** le traitement, sans sur-promettre.

## Promesse exacte

**Secrets et coordonnées masqués + traçabilité complète.**
Ce **n'est pas** une « anonymisation ». Voir la portée du masquage ci-dessous.

## Portée du masquage (à lire attentivement)

Avant **tout** appel au LLM, le système masque dans le contenu du ticket (FR-14) :

- adresses **email** ;
- numéros de **téléphone** ;
- **IBAN** ;
- **mots de passe / tokens** (motifs).

Le masquage repose sur des **expressions régulières**. En V1, il **NE masque PAS** :

- les **noms de personnes** ;
- les **adresses** postales.

La reconnaissance d'entités nommées (NER) qui couvrirait noms et adresses est prévue en **V2**. Des données nominatives peuvent donc apparaître en clair dans le contenu transmis au LLM (ex. le nom d'un agent cité dans un ticket). À communiquer tel quel : la promesse est « secrets et coordonnées masqués », **pas** « aucune donnée nominative ».

## Résidence des données

- Fournisseur LLM par défaut : **Mistral EU**, sous **DPA**, **pas de Cloud Act**. Aucun transfert hors UE par défaut.
- ⚠️ Un connecteur **Anthropic (Claude)** est sélectionnable depuis l'interface (Phase 2). Anthropic est **hors UE / non-souverain** : s'il est activé, le contenu masqué des tickets est transmis hors UE. À **valider explicitement** avec la DPO avant activation ; le défaut souverain reste Mistral EU.
- Toute l'application tourne **on-premise** sur l'infrastructure du client.
- **Aucun appel sortant** hors du fournisseur LLM configuré. **Aucun phone-home.**

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

En V1, les logs et le journal de décision sont **conservés localement sans purge automatique**. Une politique de rétention configurable reste **à préciser** (hypothèse ouverte, PRD §10) et devra être arrêtée avec le client selon ses obligations.
