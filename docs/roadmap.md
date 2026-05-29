# Roadmap

> Le pilote V1 est livré (Epics 1 → 4 + Phase 2 UI). Cf. [`CHANGELOG.md`](../CHANGELOG.md) pour l'historique détaillé.

## Pistes ouvertes

### Court terme

- **Couverture E2E étendue** — actuellement 3 parcours Playwright (login → dashboard, navigation → journal, sandbox). À ajouter : Scope/Modes (configuration du périmètre en parcours réel), EngineSettings (masquage PII configurable), Technicians (édition des fiches).
- **Store / Automations marketplace** — placeholders UI en place ; backing en cours pour la rétention RGPD. Reste à brancher les automations restantes (notifications, exports planifiés, etc.).

### Moyen terme

- **Portage PostgreSQL** — le code est déjà *Postgres-ready* : toutes les colonnes `ts` sont timezone-aware via `UtcDateTime`, les comparaisons `cutoff < ts` ne casseront pas. Migration SQLite → Postgres documentée à venir.
- **Connecteur GLPI API V2** — le seam est prêt (`get_new_tickets()`, `write_followup()`, `get_referentials()`). L'API legacy `apirest.php` reste la source de vérité tant que V2 est WIP côté GLPI 11.

### Long terme

- **Modules Enterprise** (open-core) — multi-tenant, SSO SAML, audit log signé ISO, self-service AD hors-bande. Hors cible PME, monétisés à l'unité.
- **NER française complète** pour le masquage PII (V1 = regex email/tél/IBAN/secret). Couvrira noms/adresses, à valider DPO.
- **Calibration du seuil de confiance** par catégorie et par entité (V1 = seuil unique global, configurable).

## Voir aussi

- [`CHANGELOG.md`](../CHANGELOG.md) — historique des changements livrés.
- [`docs/spike.md`](spike.md) — rapport de validation Epic 1 (gate go/no-go technique).
