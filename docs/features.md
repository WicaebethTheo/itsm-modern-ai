# Fonctionnalités

> Vue détaillée des fonctionnalités livrées dans le pilote V1.

| Fonctionnalité | Détails |
|---|---|
| **Whitelist curée depuis GLPI** | Scan GLPI (`POST /api/glpi/sync`) → l'admin sélectionne dans la console les catégories autorisées, les entités du périmètre, et les techniciens/groupes éligibles. Le moteur n'agit que dans ce **périmètre effectif** = GLPI ∩ sélections admin. |
| **Fiches techniciens en prose, en base** | Plus de YAML — chaque technicien et chaque groupe a une fiche libre éditable depuis l'UI. Le LLM s'en sert pour router ; le code rejette toute proposition hors périmètre. |
| **Routage technicien (préféré) ou groupe (fallback)** | Préférence pour un technicien nommé ; bascule sur un groupe éligible si aucun technicien ne convient. |
| **3 modes d'exécution par entité** | `suggestion` (Suivi privé, aucune mutation) · `semi_auto` (applique si confiance ≥ 2ᵉ seuil) · `full_auto` (applique + répond au demandeur en Suivi public). Réglés indépendamment par entité GLPI. Détail : [`modes.md`](modes.md). |
| **4 fournisseurs LLM interchangeables** | **Mistral EU** (défaut souverain) · **OpenAI** · **Ollama** (local, sans clé) · **Anthropic / Claude**. Changement de fournisseur sans changement de code. Détail : [`llm-providers.md`](llm-providers.md). |
| **Masquage PII configurable** | Email / téléphone / IBAN / mot de passe activables motif par motif (tous ON par défaut), avec avertissement DPO si on en désactive un. IBAN/secrets/IP-MAC/NIR-SIRET = **Enterprise**. |
| **Console DPO** | Page dédiée (`/privacy`) : tableau des catégories PII masquées par édition, outil de test du masquage, rappel des rétentions, lien vers le journal `llm_calls` et **export d'un rapport DPO** (Markdown). |
| **Cost cap glissant + page Coûts & quotas** | Plafond € / jour configurable (défaut 5 €) — au-delà, les Tickets restent « à trier » sans appel facturant. Page dédiée (`/cost`) : dépense 24 h vs plafond (jauge), appels journalisés et tarifs. |
| **Sandbox** | `POST /api/sandbox` permet de tester un texte de ticket sans toucher GLPI. UI dédiée affiche la décision simulée + résolution des noms. |
| **Journal annotable + export CSV DPO** | Chaque décision est tracée (sans PII), annotable a posteriori. Export RGPD à la demande. |
| **Durcissement production** | Conteneur non-root (`gosu` + UID 10001), rate-limiting login (avec support `X-Forwarded-For` derrière proxy), scan de dépendances en CI (`pip-audit` + `npm audit`). |

## Voir aussi

- [`docs/architecture.md`](architecture.md) — pipeline et structure du code.
- [`docs/modes.md`](modes.md) — modes d'exécution détaillés.
- [`docs/llm-providers.md`](llm-providers.md) — fournisseurs LLM.
