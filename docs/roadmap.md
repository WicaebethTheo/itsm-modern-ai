# Roadmap

> Le pilote V1 est livré (Epics 1 → 4 + Phase 2 UI). Cf. [`CHANGELOG.md`](../CHANGELOG.md) pour l'historique détaillé.

## Pistes ouvertes

### Court terme

- **Couverture E2E étendue** — actuellement 3 parcours Playwright (login → dashboard, navigation → journal, sandbox). À ajouter : Scope/Modes (configuration du périmètre en parcours réel), EngineSettings (masquage PII configurable), Technicians (édition des fiches).
- **Store / Automations marketplace** — placeholders UI en place ; backing en cours pour la rétention RGPD. Reste à brancher les automations restantes (notifications, exports planifiés, etc.).

### Moyen terme

- **Portage PostgreSQL** — ✅ **livré en Beta** (`docs/postgresql.md`). Driver `psycopg` en
  extra, pooling auto pour les bases réseau, service compose optionnel. Migrations Alembic +
  ORM validés sur PostgreSQL 16 réel. SQLite reste le défaut éprouvé. Reste à éprouver en
  prod (backups, HA, CI dédiée Postgres).
- **Connecteur GLPI API V2** — ✅ **livré en Beta** (`docs/glpi-api-v2.md`). API haut-niveau
  OAuth2 de GLPI 11 (`/Assistance/Ticket`, `Timeline/Followup`, `TeamMember`, RSQL), bascule
  `GLPI_API_VERSION=v2`. Le connecteur legacy `apirest.php` reste le **défaut** et la source
  de vérité tant que la V2 n'est pas éprouvée. À valider sur l'instance cible avant `full_auto`.

### Long terme

- **Modules Enterprise** (open-core) — multi-tenant, SSO SAML, audit log signé ISO, self-service AD hors-bande. Hors cible PME, monétisés à l'unité.
- **NER française complète** pour le masquage PII (V1 = regex email/tél/IBAN/secret). Couvrira noms/adresses, à valider DPO.
- **Calibration du seuil de confiance** par catégorie et par entité (V1 = seuil unique global, configurable).

## Voir aussi

- [`CHANGELOG.md`](../CHANGELOG.md) — historique des changements livrés.
- [`docs/spike.md`](spike.md) — rapport de validation Epic 1 (gate go/no-go technique).
