# Roadmap

> Le pilote V1 est livré (Epics 1 → 4 + Phase 2 UI). Cf. [`CHANGELOG.md`](../CHANGELOG.md) pour l'historique détaillé.

## Pistes ouvertes

### Court terme

- **Couverture E2E étendue** — actuellement 7 specs Playwright. À ajouter : Règles métier (configuration du périmètre en parcours réel), Confidentialité (DPO) (masquage PII configurable), Techniciens (édition des fiches).
- **Page Supporter / Automations marketplace** — placeholders UI en place ; backing en cours pour la rétention RGPD. Reste à brancher les automations restantes (notifications, exports planifiés, etc.).

### Moyen terme

- **Portage PostgreSQL** — ✅ **livré, et désormais EXCLUSIF** (`docs/postgresql.md`) : SQLite
  a disparu du produit. Driver `psycopg`, service `postgres` à part entière des composes,
  migrations Alembic + ORM + suite de tests validés sur **PostgreSQL 17** réel (la majeure
  des composes, du `postgresql-client-17` de l'image et de la CI — les trois bougent
  ensemble). Reste à éprouver en prod (HA, gros volumes).
- **Connecteur GLPI API V2** — ✅ **livré en Beta** (`docs/glpi-api-v2.md`). API haut-niveau
  OAuth2 de GLPI 11 (`/Assistance/Ticket`, `Timeline/Followup`, `TeamMember`, RSQL), bascule
  `GLPI_API_VERSION=v2`. Le connecteur legacy `apirest.php` reste le **défaut** et la source
  de vérité tant que la V2 n'est pas éprouvée. À valider sur l'instance cible avant `full_auto`.

### Long terme

- **Modules Supporter** (open-core) — multi-tenant, SSO SAML, audit log signé ISO, self-service AD hors-bande. Hors cible PME, et **hors du catalogue actuel** : `KNOWN_FEATURES` (`domain/licensing.py`) ne connaît que `pii_advanced`, `multi_entity` et `scheduled_exports`, et toute autre clé portée par une licence est silencieusement ignorée. Les livrer supposerait donc d'abord d'étendre le catalogue — ce ne sont pas des modules qu'une clé débloquerait aujourd'hui.
- **NER française complète** pour le masquage PII (V1 = regex email/tél/IBAN/secret). Couvrira noms/adresses, à valider DPO.
- **Calibration du seuil de confiance** par catégorie et par entité (V1 = seuil unique global, configurable).

## Voir aussi

- [`CHANGELOG.md`](../CHANGELOG.md) — historique des changements livrés.
- [`docs/spike.md`](spike.md) — rapport de validation Epic 1 (gate go/no-go technique).
