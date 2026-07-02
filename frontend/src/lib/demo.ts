/**
 * Données de DÉMO (route /demo) — simule un déploiement actif pour visualiser le
 * rendu final sans GLPI/LLM configurés. Aucune donnée réelle ; valeurs illustratives.
 */
import type {
  AuthStatus,
  ConfigView,
  CostView,
  DebugDiagnostics,
  DebugInfo,
  DecisionEntry,
  EngineStatus,
  GlpiAccount,
  Health,
  LicenseView,
  Metrics,
  OperationalView,
  PrivacyView,
  RefItem,
  RetentionView,
  Scope,
  VersionInfo,
} from "./api";

function series14() {
  const acc = [52, 61, 48, 70, 66, 31, 22, 74, 81, 69, 77, 58, 63, 75];
  const at = [28, 22, 31, 19, 24, 12, 9, 26, 21, 30, 18, 23, 20, 17];
  const out: { date: string; accepted: number; a_trier: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push({ date: d.toISOString().slice(0, 10), accepted: acc[13 - i], a_trier: at[13 - i] });
  }
  return out;
}

// Noms de démo (le vrai backend les résout depuis le cache des référentiels GLPI).
// Déclarés AVANT `demo` : l'objet appelle d() à l'initialisation du module.
const DEMO_TECH: Record<number, string> = {
  11: "Sylvain Martin",
  12: "Nadia Bouaziz",
  13: "Marc Lefèvre",
};
const DEMO_CAT: Record<number, string> = {
  1: "Compte / Authentification",
  2: "Application RH / Paie / ERP",
  3: "Poste de travail / Matériel",
  4: "Messagerie / Collaboratif",
  5: "Réseau / Sécurité",
};
const DEMO_GROUP: Record<number, string> = { 5: "Support N1", 6: "Sys / Sécu" };

export const demo: {
  authStatus: AuthStatus;
  health: Health;
  status: EngineStatus;
  metrics: Metrics;
  operational: OperationalView;
  decisions: DecisionEntry[];
  config: ConfigView;
  glpiAccount: GlpiAccount;
  technicians: RefItem[];
  groups: RefItem[];
  categories: RefItem[];
  entities: RefItem[];
  scope: Scope;
  retention: RetentionView;
  diagnostics: DebugDiagnostics;
  info: DebugInfo;
  license: LicenseView;
  version: VersionInfo;
  privacy: PrivacyView;
  cost: CostView;
} = {
  authStatus: { authenticated: true, auth_configured: false },
  info: {
    version: "0.9.46",
    title: "ITSM Modern AI — moteur de triage (headless)",
    endpoints: [
      { path: "/health", methods: ["GET"] },
      { path: "/api/status", methods: ["GET"] },
      { path: "/api/metrics", methods: ["GET"] },
      { path: "/api/operational-metrics", methods: ["GET"] },
      { path: "/api/config", methods: ["GET", "POST"] },
      { path: "/api/glpi/sync", methods: ["POST"] },
      { path: "/api/discovery/{kind}", methods: ["GET"] },
      { path: "/api/scope", methods: ["GET", "PUT"] },
      { path: "/api/technicians", methods: ["PUT"] },
      { path: "/api/groups", methods: ["PUT"] },
      { path: "/api/decisions", methods: ["GET"] },
      { path: "/api/decisions/{decision_id}/annotation", methods: ["PATCH"] },
      { path: "/api/export/decisions.csv", methods: ["GET"] },
      { path: "/api/sandbox", methods: ["POST"] },
      { path: "/api/auth/login", methods: ["POST"] },
      { path: "/api/privacy", methods: ["GET"] },
      { path: "/api/privacy/test-mask", methods: ["POST"] },
      { path: "/api/privacy/report.md", methods: ["GET"] },
      { path: "/api/cost", methods: ["GET"] },
    ],
  },
  diagnostics: {
    glpi: {
      configured: true,
      reachable: true,
      referentials: { categories: 8, technicians: 63, groups: 2, entities: 1, profiles: 62 },
      new_tickets: 2,
      recent_tickets_14d: 14,
    },
    llm: { configured: true, reachable: true },
  },
  health: {
    status: "ok",
    glpi: { configured: true, reachable: true, version: "10.0.18" },
    llm: { configured: true, reachable: true },
  },
  status: {
    ok: true,
    version: "0.9.46", // même valeur que APP_VERSION — règle de release
    polling_enabled: true,
    polling_interval_seconds: 60,
    whitelist_loaded: true,
    categories_count: 7,
    technicians_count: 4,
    llm_calls_total: 1284,
    cost_eur_last_24h: 1.83,
    cost_cap_eur_per_day: 5,
  },
  metrics: {
    total: 1284,
    accepted: 847,
    a_trier: 437,
    useful_coverage: 0.66,
    by_reason: {
      accepted: 847,
      low_confidence: 198,
      technician_not_in_whitelist: 96,
      category_not_in_whitelist: 61,
      llm_error: 47,
      cost_cap_reached: 35,
    },
    llm_calls: 1284,
    cost_eur_last_24h: 1.83,
    cost_cap_eur_per_day: 5,
    avg_confidence: 0.87,
    series: series14(),
  },
  operational: {
    available: true,
    detail: "",
    metrics: {
      window_days: 14,
      tickets_in_window: 1284,
      first_response_median_minutes: 12.5,
      sla_compliance_rate: 0.91,
      sla_evaluated: 540,
      reassignment_rate: null,
      reassignment_available: false,
      anomalies: [
        {
          ticket_id: 48190,
          kind: "new_stale",
          detail: "« New » depuis 31 h",
          glpi_link: "https://glpi.demo.local/front/ticket.form.php?id=48190",
        },
        {
          ticket_id: 48172,
          kind: "sla_breached",
          detail: "SLA TTR dépassé, non résolu",
          glpi_link: "https://glpi.demo.local/front/ticket.form.php?id=48172",
        },
        {
          ticket_id: 48155,
          kind: "new_stale",
          detail: "« New » depuis 27 h",
          glpi_link: "https://glpi.demo.local/front/ticket.form.php?id=48155",
        },
      ],
    },
  },
  decisions: [
    d(48217, true, "accepted", 6, 2, 13, null, 0.94, "Imprimante 3e étage hors-ligne"),
    d(48216, true, "accepted", 1, 3, 11, null, 0.89, "Réinitialisation mot de passe AD"),
    d(48215, false, "low_confidence", 4, 3, null, null, 0.61, "Outlook ne synchronise plus"),
    d(48214, true, "accepted", 2, 2, null, 5, 0.92, "Demande accès dossier RH"),
    d(48213, true, "accepted", 5, 4, 11, null, 0.88, "Wifi instable open space"),
    d(
      48212,
      false,
      "technician_not_in_whitelist",
      3,
      2,
      null,
      null,
      0.71,
      "PC portable ne démarre plus",
    ),
    d(48211, true, "accepted", 7, 2, 13, null, 0.9, "Téléphone fixe muet"),
    d(48210, true, "accepted", 2, 3, null, 5, 0.86, "ERP plante à la validation"),
  ],
  config: {
    glpi_base_url: "https://glpi.demo.local/apirest.php",
    glpi_verify_tls: "true",
    glpi_followup_legacy_9x: "false",
    llm_provider: "anthropic",
    llm_base_url: "https://api.mistral.ai/v1",
    llm_model: "mistral-large-latest",
    openai_base_url: "https://api.openai.com/v1",
    openai_model: "gpt-4o-mini",
    ollama_base_url: "http://localhost:11434/v1",
    ollama_model: "llama3.1",
    anthropic_base_url: "https://api.anthropic.com",
    anthropic_model: "claude-sonnet-4-6",
    llm_price_input_per_mtok: "2.0",
    llm_price_output_per_mtok: "6.0",
    confidence_threshold: "0.7",
    cost_cap_eur_per_day: "5",
    llm_retries: "1",
    response_tone: "professionnel, courtois et concis",
    assistant_name: "Support IT",
    routing_rules: "",
    system_prompt: "",
    system_prompt_default: "(prompt par défaut intégré)",
    execution_mode_default: "suggestion",
    auto_min_confidence_default: "0.9",
    polling_enabled: "true",
    polling_interval_seconds: "60",
    dashboard_window_days: "14",
    anomaly_new_age_hours: "24",
    mask_email: "true",
    mask_phone: "true",
    mask_iban: "true",
    mask_secret: "true",
    glpi_user_token_set: true,
    glpi_app_token_set: false,
    glpi_api_version: "legacy",
    glpi_v2_base_url: "",
    glpi_oauth_client_id: "",
    glpi_oauth_username: "",
    glpi_oauth_scope: "api user",
    glpi_oauth_client_secret_set: false,
    glpi_oauth_password_set: false,
    llm_api_key_set: true,
    openai_api_key_set: false,
    anthropic_api_key_set: true,
  },
  glpiAccount: {
    api_version: "legacy",
    configured: true,
    account: "Bot Triage IT",
    username: "svc_triage",
    profile: "Technician",
    email: "bot.triage@demo.local",
    has_picture: false,
  },
  technicians: [
    ref(
      11,
      "Sylvain Martin",
      true,
      "AD, comptes, sécurité réseau (VPN, phishing)",
      false,
      "Technician",
    ),
    ref(12, "Nadia Bouaziz", true, "SIRH, paie, ERP, applications métier", false, "Technician"),
    ref(
      13,
      "Marc Lefèvre",
      true,
      "Postes de travail, imprimantes, téléphonie",
      false,
      "Technician",
    ),
    ref(14, "Léa Roche", false, "", false, "Self-Service"),
    ref(15, "Admin Système", false, "", false, "Super-Admin"),
    ref(16, "Karim Idrissi", false, "", false, "Admin"),
  ],
  groups: [
    ref(5, "Support N1", true, "Premier niveau, demandes courantes"),
    ref(6, "Sys / Sécu", true, "Infra, sécurité, AD"),
  ],
  categories: [
    ref(1, "Compte / Authentification", false, "", true),
    ref(2, "Application RH / Paie / ERP", false, "", true),
    ref(3, "Poste de travail / Matériel", false, "", true),
    ref(4, "Messagerie / Collaboratif", false, "", true),
    ref(5, "Réseau / Sécurité", false, "", true),
  ],
  entities: [ref(0, "Racine", false, "", true), ref(1, "Siège", false, "", true)],
  scope: { category_ids: [1, 2, 3, 4, 5], entity_ids: [0, 1] },
  retention: {
    enabled: true,
    decisions_days: 365,
    llm_calls_days: 90,
    hour_utc: 3,
    last_run_at: new Date(Date.now() - 18 * 3600 * 1000).toISOString(),
    last_decisions_deleted: 12,
    last_llm_calls_deleted: 47,
    last_run_by: "scheduler",
  },
  version: {
    current: "0.9.46",
    latest: null,
    update_available: false,
    check_enabled: false,
    latest_notes: null,
    runtime: "docker",
  },
  // Démo : édition Community → tout le catalogue Supporter est verrouillé.
  license: {
    edition: "community",
    valid: true,
    customer: null,
    issued_at: null,
    expires_at: null,
    error: null,
    features: [
      {
        key: "pii_advanced",
        label_fr: "Masquage PII avancé",
        label_en: "Advanced PII masking",
        description_fr:
          "Masquage des IBAN/cartes et des secrets (mots de passe, tokens, clés API), identifiants FR (NIR, SIRET), patterns regex personnalisés et règles par entité. En Community, seuls e-mail et téléphone sont masqués.",
        description_en:
          "Masking of IBANs/cards and secrets (passwords, tokens, API keys), French identifiers (NIR, SIRET), custom regex patterns and per-entity rules. In Community, only email and phone are masked.",
        installed: false,
        entitled: false,
        active: false,
      },
      {
        key: "multi_entity",
        label_fr: "Multi-entités avancé (à venir)",
        label_en: "Advanced multi-entity (coming soon)",
        description_fr:
          "À VENIR. Gestion fine multi-entités : politiques de triage et seuils par entité, héritage hiérarchique, tableaux de bord par entité.",
        description_en:
          "COMING SOON. Fine-grained multi-entity management: per-entity triage policies and thresholds, hierarchical inheritance, per-entity dashboards.",
        installed: false,
        entitled: false,
        active: false,
      },
      {
        key: "scheduled_exports",
        label_fr: "Exports planifiés / DPO+ (à venir)",
        label_en: "Scheduled exports / DPO+ (coming soon)",
        description_fr:
          "À VENIR. Exports CSV planifiés (cron), rapports DPO enrichis et envois automatiques. L'export CSV manuel reste inclus en Community.",
        description_en:
          "COMING SOON. Scheduled CSV exports (cron), enriched DPO reports and automatic delivery. Manual CSV export remains included in Community.",
        installed: false,
        entitled: false,
        active: false,
      },
    ],
  },
  // Démo : édition Community → email + téléphone masqués ; le reste = Supporter (inactif).
  privacy: {
    edition_advanced: false,
    retention_decisions_days: 365,
    retention_llm_calls_days: 90,
    llm_calls_count: 1284,
    categories: [
      {
        key: "email",
        label_fr: "Adresses e-mail",
        label_en: "Email addresses",
        example: "alice@acme.com",
        scope: "community",
        active: true,
      },
      {
        key: "phone",
        label_fr: "Numéros de téléphone",
        label_en: "Phone numbers",
        example: "+33 6 12 34 56 78",
        scope: "community",
        active: true,
      },
      {
        key: "iban",
        label_fr: "IBAN & cartes de paiement",
        label_en: "IBAN & payment cards",
        example: "FR76 3000 4000 …",
        scope: "supporter",
        active: false,
      },
      {
        key: "secret",
        label_fr: "Secrets, tokens, mots de passe, clés API",
        label_en: "Secrets, tokens, passwords, API keys",
        example: "sk-•••••, Bearer •••",
        scope: "supporter",
        active: false,
      },
      {
        key: "network",
        label_fr: "IP & MAC",
        label_en: "IP & MAC",
        example: "10.0.1.42, a4:5e:60:…",
        scope: "supporter",
        active: false,
      },
      {
        key: "nir_siret",
        label_fr: "NIR / SIRET",
        label_en: "NIR / SIRET",
        example: "1 85 12 …, 552 120 …",
        scope: "supporter",
        active: false,
      },
      {
        key: "custom",
        label_fr: "Motifs personnalisés (regex)",
        label_en: "Custom patterns (regex)",
        example: "TICKET-\\d{5}",
        scope: "roadmap",
        active: false,
      },
    ],
  },
  cost: {
    cost_cap_eur_per_day: 5,
    spent_eur_last_24h: 1.83,
    pct_of_cap: 36.6,
    over_cap: false,
    llm_calls_total: 1284,
    price_input_per_mtok: 0.15,
    price_output_per_mtok: 0.6,
    currency: "EUR",
  },
};

function d(
  id: number,
  accepted: boolean,
  reason: string,
  category: number | null,
  priority: number | null,
  technician_id: number | null,
  group_id: number | null,
  confidence: number,
  subject: string,
): DecisionEntry {
  const ts = new Date(Date.now() - id * 1000).toISOString();
  return {
    id,
    ticket_id: id,
    ts,
    subject,
    accepted,
    reason,
    category,
    category_name: category != null ? (DEMO_CAT[category] ?? null) : null,
    priority,
    urgency: priority != null ? Math.min(priority, 5) : null,
    technician_id,
    technician_name: technician_id != null ? (DEMO_TECH[technician_id] ?? null) : null,
    group_id,
    group_name: group_id != null ? (DEMO_GROUP[group_id] ?? null) : null,
    confidence,
    glpi_link: `https://glpi.demo.local/front/ticket.form.php?id=${id}`,
    annotation: "", // annotation manuelle (vide en démo)
    mode: "suggestion", // démo : pilote en mode suggestion (sûr)
    applied: false,
  };
}

function ref(
  ext_id: number,
  name: string,
  on: boolean,
  skills: string,
  selected = false,
  profile = "",
): RefItem {
  return { ext_id, name, profile, selected: selected ? true : on, eligible: on, skills };
}
