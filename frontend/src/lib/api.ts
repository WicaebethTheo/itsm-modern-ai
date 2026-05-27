/**
 * Client API typé — point d'entrée UNIQUE vers le moteur (backend REST).
 *
 * Tout ajout d'endpoint backend se reflète ici (types + méthode), ce qui garde
 * l'UI facile à étendre : les pages n'appellent jamais `fetch` directement.
 */

import { demo } from "./demo";

export class ApiError extends Error {
  constructor(
    public status: number,
    public payload: unknown,
  ) {
    super(`API ${status}`);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include", // session cookie d'auth locale (FR-24)
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

// ── Types (miroir des modèles backend) ───────────────────────────────────────
export const APP_VERSION = "0.7.0";

export type LlmProvider = "mistral" | "openai" | "ollama" | "anthropic";

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  mistral: "Mistral EU (souverain)",
  openai: "OpenAI",
  ollama: "Ollama (local)",
  anthropic: "Anthropic (Claude)",
};

export type RefKind = "category" | "entity" | "technician" | "group";

export interface AuthStatus {
  authenticated: boolean;
  auth_configured: boolean;
}

export interface Health {
  status: "ok" | "degraded";
  glpi: { configured: boolean; reachable: boolean; version?: string | null };
  llm: { configured: boolean; reachable: boolean | null };
}

export interface EngineStatus {
  polling_enabled: boolean;
  polling_interval_seconds: number;
  whitelist_loaded: boolean;
  categories_count: number;
  technicians_count: number;
  llm_calls_total: number;
  cost_eur_last_24h: number;
  cost_cap_eur_per_day: number;
}

export interface DayPoint {
  date: string;
  accepted: number;
  a_trier: number;
}

export interface Metrics {
  total: number;
  accepted: number;
  a_trier: number;
  useful_coverage: number;
  by_reason: Record<string, number>;
  llm_calls: number;
  cost_eur_last_24h: number;
  cost_cap_eur_per_day: number;
  avg_confidence: number | null;
  series: DayPoint[];
}

export interface ConfigView {
  glpi_base_url: string | null;
  llm_provider: LlmProvider | null;
  llm_base_url: string | null;
  llm_model: string | null;
  openai_base_url: string | null;
  openai_model: string | null;
  ollama_base_url: string | null;
  ollama_model: string | null;
  anthropic_base_url: string | null;
  anthropic_model: string | null;
  confidence_threshold: string | null;
  cost_cap_eur_per_day: string | null;
  llm_retries: string | null;
  response_tone: string | null;
  assistant_name: string | null;
  routing_rules: string | null;
  system_prompt: string | null;
  system_prompt_default: string | null;
  execution_mode_default: string | null;
  auto_min_confidence_default: string | null;
  polling_enabled: string | null;
  polling_interval_seconds: string | null;
  dashboard_window_days: string | null;
  anomaly_new_age_hours: string | null;
  mask_email: string | null;
  mask_phone: string | null;
  mask_iban: string | null;
  mask_secret: string | null;
  glpi_verify_tls: string | null;
  glpi_followup_legacy_9x: string | null;
  glpi_user_token_set: boolean;
  glpi_app_token_set: boolean;
  llm_api_key_set: boolean;
  openai_api_key_set: boolean;
  anthropic_api_key_set: boolean;
}

export interface ConfigUpdate {
  glpi_base_url?: string;
  glpi_verify_tls?: boolean;
  glpi_followup_legacy_9x?: boolean;
  llm_provider?: LlmProvider;
  llm_base_url?: string;
  llm_model?: string;
  openai_base_url?: string;
  openai_model?: string;
  ollama_base_url?: string;
  ollama_model?: string;
  anthropic_base_url?: string;
  anthropic_model?: string;
  confidence_threshold?: number;
  cost_cap_eur_per_day?: number;
  llm_retries?: number;
  response_tone?: string;
  assistant_name?: string;
  routing_rules?: string;
  system_prompt?: string;
  execution_mode_default?: ExecutionMode;
  auto_min_confidence_default?: number;
  polling_enabled?: boolean;
  polling_interval_seconds?: number;
  dashboard_window_days?: number;
  anomaly_new_age_hours?: number;
  mask_email?: boolean;
  mask_phone?: boolean;
  mask_iban?: boolean;
  mask_secret?: boolean;
  glpi_user_token?: string;
  glpi_app_token?: string;
  llm_api_key?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
}

/** Vrai si une valeur de config stockée en chaîne représente un booléen vrai. */
export function asBool(v: string | null | undefined): boolean {
  return v != null && ["1", "true", "yes", "on", "vrai"].includes(v.trim().toLowerCase());
}

export interface DecisionEntry {
  id: number;
  ticket_id: number;
  ts: string;
  subject: string;
  accepted: boolean;
  reason: string;
  category: number | null;
  category_name?: string | null; // libellé GLPI résolu (sinon on affiche l'id)
  priority: number | null;
  urgency?: number | null; // urgence appliquée = min(priority, 5)
  technician_id: number | null;
  technician_name?: string | null; // nom GLPI du technicien routé
  group_id: number | null;
  group_name?: string | null; // nom GLPI du groupe routé
  confidence: number | null;
  glpi_link: string;
  annotation: string;
  mode?: string; // mode d'exécution résolu (suggestion | semi_auto | full_auto)
  applied?: boolean; // la Décision a-t-elle muté les champs du Ticket GLPI
}

export type ExecutionMode = "suggestion" | "semi_auto" | "full_auto";

export interface RefItem {
  ext_id: number;
  name: string;
  profile: string;
  selected: boolean;
  eligible: boolean;
  skills: string;
  mode?: ExecutionMode | null;
  auto_min_confidence?: number | null;
}

export interface ModeItem {
  ext_id: number;
  mode: ExecutionMode | null;
  auto_min_confidence?: number | null;
}

export interface SyncResult {
  ok: boolean;
  detail: string;
  counts: Record<string, number>;
}

export interface Scope {
  category_ids: number[];
  entity_ids: number[];
}

export interface EligibilityItem {
  ext_id: number;
  eligible: boolean;
  skills: string;
}

export interface Anomaly {
  ticket_id: number;
  kind: string;
  detail: string;
  glpi_link?: string | null; // lien front GLPI vers le ticket (si URL configurée)
}

export interface OperationalMetrics {
  window_days: number;
  tickets_in_window: number;
  first_response_median_minutes: number | null;
  sla_compliance_rate: number | null;
  sla_evaluated: number;
  reassignment_rate: number | null;
  reassignment_available: boolean;
  anomalies: Anomaly[];
}

export interface OperationalView {
  available: boolean;
  detail: string;
  metrics: OperationalMetrics | null;
}

export interface DebugDiagnostics {
  glpi: {
    configured: boolean;
    reachable?: boolean;
    referentials?: Record<string, number>;
    new_tickets?: number;
    recent_tickets_14d?: number;
    error?: string;
  };
  llm: { configured: boolean; reachable?: boolean; error?: string };
}

export interface DebugInfo {
  version: string;
  title: string;
  endpoints: { path: string; methods: string[] }[];
}

export interface SandboxResult {
  accepted: boolean;
  reason: string;
  category: number | null;
  priority: number | null;
  technician_id: number | null;
  group_id: number | null;
  confidence: number | null;
  draft: string | null;
}

/** Mode démo : l'app est servie sous /demo → toutes les données sont simulées. */
export const DEMO =
  typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "").startsWith("/demo");

const ok = <T>(v: T): Promise<T> => Promise.resolve(v);

// ── Endpoints regroupés par domaine ──────────────────────────────────────────
export const Api = {
  authStatus: () => (DEMO ? ok(demo.authStatus) : api.get<AuthStatus>("/api/auth/status")),
  login: (password: string) => api.post<AuthStatus>("/api/auth/login", { password }),
  logout: () => (DEMO ? ok(demo.authStatus) : api.post<AuthStatus>("/api/auth/logout")),

  health: () => (DEMO ? ok(demo.health) : api.get<Health>("/health")),
  status: () => (DEMO ? ok(demo.status) : api.get<EngineStatus>("/api/status")),
  metrics: () => (DEMO ? ok(demo.metrics) : api.get<Metrics>("/api/metrics")),
  operationalMetrics: () =>
    DEMO ? ok(demo.operational) : api.get<OperationalView>("/api/operational-metrics"),

  getConfig: () => (DEMO ? ok(demo.config) : api.get<ConfigView>("/api/config")),
  updateConfig: (body: ConfigUpdate) =>
    DEMO ? ok(demo.config) : api.post<ConfigView>("/api/config", body),

  // Référentiels GLPI : scan + découverte + sélection du périmètre.
  syncGlpi: () =>
    DEMO
      ? ok({
          ok: true,
          detail: "Démo : référentiels simulés.",
          counts: { category: 5, technician: 4, group: 2, entity: 2 },
        })
      : api.post<SyncResult>("/api/glpi/sync"),
  discovery: (kind: RefKind) =>
    DEMO
      ? ok(
          kind === "technician"
            ? demo.technicians
            : kind === "group"
              ? demo.groups
              : kind === "entity"
                ? demo.entities
                : demo.categories,
        )
      : api.get<RefItem[]>(`/api/discovery/${kind}`),
  saveTechnicians: (items: EligibilityItem[]) =>
    DEMO ? ok(demo.technicians) : api.put<RefItem[]>("/api/technicians", items),
  saveGroups: (items: EligibilityItem[]) =>
    DEMO ? ok(demo.groups) : api.put<RefItem[]>("/api/groups", items),
  getScope: () => (DEMO ? ok(demo.scope) : api.get<Scope>("/api/scope")),
  setScope: (scope: Scope) => (DEMO ? ok(scope) : api.put<Scope>("/api/scope", scope)),
  saveModes: (items: ModeItem[]) =>
    DEMO ? ok([] as RefItem[]) : api.put<RefItem[]>("/api/modes", items),

  decisions: () => (DEMO ? ok(demo.decisions) : api.get<DecisionEntry[]>("/api/decisions")),
  annotate: (id: number, annotation: string) =>
    DEMO
      ? ok({ ...demo.decisions[0], id, annotation })
      : api.patch<DecisionEntry>(`/api/decisions/${id}/annotation`, { annotation }),

  // Outils de debug (labo/test).
  debugStatus: () =>
    DEMO ? ok({ enabled: true }) : api.get<{ enabled: boolean }>("/api/debug/status"),
  debugInfo: () => (DEMO ? ok(demo.info) : api.get<DebugInfo>("/api/debug/info")),
  debugDiagnostics: () =>
    DEMO ? ok(demo.diagnostics) : api.get<DebugDiagnostics>("/api/debug/diagnostics"),
  debugSeed: (technicians: number, groups: number) =>
    DEMO
      ? ok({ users: [65, 66], groups: [3] })
      : api.post<{ users: number[]; groups: number[] }>("/api/debug/seed", { technicians, groups }),
  debugPurgeUsers: (confirm: string) =>
    DEMO
      ? ok({ deleted: 0, kept: 64, protected_user_id: 2 })
      : api.post<{ deleted: number; kept: number; protected_user_id: number }>(
          "/api/debug/purge-users",
          { confirm },
        ),

  sandbox: (content: string, title = "") =>
    DEMO
      ? ok({
          accepted: true,
          reason: "accepted",
          category: 1,
          priority: 3,
          technician_id: 11,
          group_id: null,
          confidence: 0.9,
          draft: "Bonjour, nous avons bien reçu votre demande et la prenons en charge.",
        } satisfies SandboxResult)
      : api.post<SandboxResult>("/api/sandbox", { title, content }),
};
