/**
 * Client API typé — point d'entrée UNIQUE vers le moteur (backend REST).
 *
 * Tout ajout d'endpoint backend se reflète ici (types + méthode), ce qui garde
 * l'UI facile à étendre : les pages n'appellent jamais `fetch` directement.
 */

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
  glpi: { configured: boolean; reachable: boolean };
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

export interface Metrics {
  total: number;
  accepted: number;
  a_trier: number;
  useful_coverage: number;
  by_reason: Record<string, number>;
  llm_calls: number;
  cost_eur_last_24h: number;
  cost_cap_eur_per_day: number;
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
  glpi_user_token_set: boolean;
  glpi_app_token_set: boolean;
  llm_api_key_set: boolean;
  openai_api_key_set: boolean;
  anthropic_api_key_set: boolean;
}

export interface ConfigUpdate {
  glpi_base_url?: string;
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
  glpi_user_token?: string;
  glpi_app_token?: string;
  llm_api_key?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
}

export interface DecisionEntry {
  id: number;
  ticket_id: number;
  ts: string;
  accepted: boolean;
  reason: string;
  category: number | null;
  priority: number | null;
  technician_id: number | null;
  group_id: number | null;
  confidence: number | null;
  glpi_link: string;
  annotation: string;
}

export interface RefItem {
  ext_id: number;
  name: string;
  selected: boolean;
  eligible: boolean;
  skills: string;
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

// ── Endpoints regroupés par domaine ──────────────────────────────────────────
export const Api = {
  authStatus: () => api.get<AuthStatus>("/api/auth/status"),
  login: (password: string) => api.post<AuthStatus>("/api/auth/login", { password }),
  logout: () => api.post<AuthStatus>("/api/auth/logout"),

  health: () => api.get<Health>("/health"),
  status: () => api.get<EngineStatus>("/api/status"),
  metrics: () => api.get<Metrics>("/api/metrics"),

  getConfig: () => api.get<ConfigView>("/api/config"),
  updateConfig: (body: ConfigUpdate) => api.post<ConfigView>("/api/config", body),

  // Référentiels GLPI : scan + découverte + sélection du périmètre.
  syncGlpi: () => api.post<SyncResult>("/api/glpi/sync"),
  discovery: (kind: RefKind) => api.get<RefItem[]>(`/api/discovery/${kind}`),
  saveTechnicians: (items: EligibilityItem[]) => api.put<RefItem[]>("/api/technicians", items),
  saveGroups: (items: EligibilityItem[]) => api.put<RefItem[]>("/api/groups", items),
  getScope: () => api.get<Scope>("/api/scope"),
  setScope: (scope: Scope) => api.put<Scope>("/api/scope", scope),

  decisions: () => api.get<DecisionEntry[]>("/api/decisions"),
  annotate: (id: number, annotation: string) =>
    api.patch<DecisionEntry>(`/api/decisions/${id}/annotation`, { annotation }),

  sandbox: (content: string, title = "") =>
    api.post<SandboxResult>("/api/sandbox", { title, content }),
};
