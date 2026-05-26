/**
 * Données de DÉMO (route /demo) — simule un déploiement actif pour visualiser le
 * rendu final sans GLPI/LLM configurés. Aucune donnée réelle ; valeurs illustratives.
 */
import type {
  AuthStatus,
  ConfigView,
  DebugDiagnostics,
  DebugInfo,
  DecisionEntry,
  EngineStatus,
  Health,
  Metrics,
  OperationalView,
  RefItem,
  Scope,
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

export const demo: {
  authStatus: AuthStatus;
  health: Health;
  status: EngineStatus;
  metrics: Metrics;
  operational: OperationalView;
  decisions: DecisionEntry[];
  config: ConfigView;
  technicians: RefItem[];
  groups: RefItem[];
  categories: RefItem[];
  entities: RefItem[];
  scope: Scope;
  diagnostics: DebugDiagnostics;
  info: DebugInfo;
} = {
  authStatus: { authenticated: true, auth_configured: false },
  info: {
    version: "0.7.0",
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
    glpi: { configured: true, reachable: true },
    llm: { configured: true, reachable: true },
  },
  status: {
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
        { ticket_id: 48190, kind: "new_stale", detail: "« New » depuis 31 h" },
        { ticket_id: 48172, kind: "sla_breached", detail: "SLA TTR dépassé, non résolu" },
        { ticket_id: 48155, kind: "new_stale", detail: "« New » depuis 27 h" },
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
    confidence_threshold: "0.7",
    cost_cap_eur_per_day: "5",
    llm_retries: "1",
    response_tone: "professionnel, courtois et concis",
    assistant_name: "Support IT",
    routing_rules: "",
    system_prompt: "",
    system_prompt_default: "(prompt par défaut intégré)",
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
    llm_api_key_set: true,
    openai_api_key_set: false,
    anthropic_api_key_set: true,
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
    priority,
    technician_id,
    group_id,
    confidence,
    glpi_link: `https://glpi.demo.local/front/ticket.form.php?id=${id}`,
    annotation: "", // annotation manuelle (vide en démo)
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
