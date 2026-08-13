# Fournisseurs LLM

> Quatre fournisseurs interchangeables, configurés via l'UI. Les clés sont **chiffrées Fernet au repos** (jamais stockées en clair, jamais dans `.env`).

| Fournisseur | Souveraineté | Clé requise | Notes |
|---|---|:---:|---|
| **Mistral EU** | Souverain UE — **défaut** | oui | DPA signé, pas de Cloud Act. |
| **Ollama** | 100 % **local** | non | Exécution sur l'infra du client, aucune donnée ne sort. |
| **OpenAI** | Hors UE | oui | Activation = choix explicite de l'opérateur, validation DPO. |
| **Anthropic / Claude** | Hors UE | oui | Idem OpenAI ; supporte Sonnet 4.6+. |

Sélection sans code (UI → page **Fournisseur IA**). Le défaut souverain reste **Mistral EU**.

## Architecture du connecteur

Deux chemins de code couvrent les 4 fournisseurs :

- **Adaptateur OpenAI-compatible** → couvre Mistral EU, OpenAI, Ollama (tous parlent le même schéma `chat/completions` avec `response_format: json_object`).
- **Adaptateur Anthropic** → Claude (API Messages, schéma différent, pas de JSON mode natif — JSON forcé via prompt + extracteur tolérant côté code).

Les deux adaptateurs partagent un helper HTTP commun (`adapters/llm/_http.py`) qui capture les codes 4xx pour diagnostic et gère le retry. La validation Pydantic se fait **à la frontière** de l'adaptateur — toute réponse non conforme déclenche le fallback « à trier ».

### Bornes de génération (`max_tokens`)

La sortie attendue est un petit objet JSON « Décision ». L'adaptateur OpenAI-compatible
borne la génération à **`max_tokens = 1024`** par défaut (aligné sur l'adaptateur Anthropic),
ce qui **plafonne le coût et la latence** d'une réponse pathologique (OWASP **LLM10 —
consommation non bornée**). Cette borne s'ajoute au **cost cap** journalier ci-dessous.

### Garde anti-SSRF sur les URLs de base

Les URLs de base sont poussées via l'API/UI et la clé LLM part en en-tête `Authorization`
vers cette URL : une URL malveillante provoquerait un SSRF + fuite de clé. Deux garde-fous
(durcissement audit 2026-05) :

- **À l'écriture de config** (validation lexicale) : les fournisseurs publics (**Mistral**,
  **OpenAI**, **Anthropic**) exigent `https://` et un **hôte routable** ; loopback, IP privée
  et metadata cloud sont **rejetés**. **Ollama** est local → `http://` + hôte local/privé tolérés.
- **Au runtime** (`ssrf_guard_enabled`, défaut `true`, anti DNS-rebinding) : avant chaque
  appel, l'hôte est **résolu** et toute IP interne est **bloquée** (localhost toléré pour Ollama).

Détails et limite résiduelle : [`docs/audit-2026-05.md`](audit-2026-05.md).

## Cost cap

Chaque appel LLM est journalisé avec son coût estimé (`cost_eur` calculé depuis `prompt_tokens` et `completion_tokens` × prix du modèle). Au-delà du **cap journalier** (fenêtre glissante 24 h, défaut **5 €/jour**), les Tickets restent en « à trier » sans appel facturant — le cap est consultable depuis l'UI (`GET /api/metrics`).

## Souveraineté & DPO

- Mistral EU et Ollama ne posent **aucun problème de transfert hors UE**.
- OpenAI et Anthropic sont **hors UE** — leur activation doit être tracée auprès de la DPO (cf. [`docs/dpo.md`](dpo.md)).
- L'UI affiche un avertissement souveraineté lorsque l'opérateur sélectionne un fournisseur hors UE.

## Voir aussi

- [`docs/dpo.md`](dpo.md) — fiche DPO RGPD.
- [`docs/architecture.md`](architecture.md) — pipeline et masquage PII.
