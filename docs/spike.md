# Spike de routage — Epic 1 (gate Phase 0)

Objectif : trancher le **go/no-go technique** avant de construire le pilote. On valide
deux paris :

1. **Routage par Fiches techniciens en prose** (FR-15) — le différenciateur, non démontré.
2. **Précision LLM sur tickets FR mal formulés** (argot, abréviations, fautes).

On mesure la **couverture utile** (% de la Queue longue recevant une Décision exploitable
vs « à trier ») et on calibre un **seuil de confiance de départ** (FR-8).

## Exécution

```bash
# Vraie mesure (nécessite une clé Mistral EU dans .env → LLM_API_KEY)
make spike
# ou : uv run python scripts/spike_routing.py --real

# Plomberie offline (mock déterministe — NON représentatif de la précision réelle)
make spike-mock
```

Options utiles : `--threshold 0.6`, `--limit 5`, `--fixtures <path>`, `--profiles <path>`.

## Entrées

- `tests/fixtures/tickets_fr.json` — jeu de tickets FR annotés (vérité terrain). Contient
  les **référentiels** (= Whitelist : catégories, priorités, techniciens) et les tickets
  avec leur triage humain attendu. Inclut des cas flous, des signaux faibles, et des cas
  hors-périmètre (`expected_outcome: "a_trier"`). **À enrichir avec de vrais tickets
  anonymisés** du homelab/pilote pour une mesure crédible.
- `docs/tech-profiles.example.yaml` — Fiches techniciens en **prose libre** (FR-15).

## Pipeline (ordre immuable, réutilisé par l'Epic 3)

```
Masquage PII (FR-14) → LLM JSON mode (FR-6/11) → validation Pydantic
→ validation Whitelist (FR-7) → seuil de confiance (FR-8) → décision / « à trier »
```

## Sorties

`spike-report.md` (lisible) + `spike-report.json` (machine) :

- **Couverture utile** et **justesse de routage** (catégorie + technicien) au seuil configuré.
- **Balayage de seuils** (0,00 → 0,95) avec, pour chacun : couverture, justesse parmi les
  acceptés, et nombre de **faux-acceptés hors-périmètre** (doit rester à 0).
- **Seuil de départ suggéré** (maximise couverture × justesse, zéro faux-accepté si possible).
- **Masquage** : nombre de motifs PII masqués, flags secret levés.
- **Cas d'échec saillants** (mauvais routage, raté « à trier », faux-accepté).
- **Verdict** : viable / prometteur / à revoir.

## Lecture du verdict (critère go/no-go)

Le verdict est une **heuristique d'aide**, pas la décision finale. Le GO réel (PRD §7)
combine le spike **et** le terrain : douleur « qualité plancher » qui résonne chez ≥3/5 DSI,
technicien juge qui trouve les Décisions crédibles, couverture utile jugée suffisante.

⚠️ La Confiance LLM est **auto-déclarée, non calibrée**. Le seuil suggéré est un point de
départ, à affiner sur les Décisions validées du pilote. Un échantillon de ~15 tickets est
**statistiquement maigre** : élargir le jeu avant de conclure.
