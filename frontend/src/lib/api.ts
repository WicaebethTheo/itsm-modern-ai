/**
 * Client API typé — point d'entrée UNIQUE vers le moteur (backend REST).
 *
 * Tout ajout d'endpoint backend se reflète ici (types + méthode), ce qui garde
 * l'UI facile à étendre : les pages n'appellent jamais `fetch` directement.
 */

import { demo } from "./demo";
import { tr } from "./i18n";

/** Extrait `payload.detail.message` (format d'erreur du backend) sans présumer de la forme. */
function detailMessage(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (detail && typeof detail === "object" && "message" in detail) {
      const m = (detail as { message?: unknown }).message;
      if (typeof m === "string" && m) return m;
    }
    // Défensif : le style FastAPI par défaut est `{"detail": "…"}` (string). Notre
    // backend n'en émet pas aujourd'hui, mais un futur endpoint pourrait.
    if (typeof detail === "string" && detail) return detail;
  }
  return null;
}

/**
 * Message lisible d'une erreur API : le backend renvoie `detail.message` quand il
 * a quelque chose à dire ; sinon un libellé par status connu, sinon `API <status>`.
 * Centralisé ici pour que chaque page n'ait pas à fouiller le payload elle-même.
 */
function errorMessage(status: number, payload: unknown): string {
  const detail = detailMessage(payload);
  if (detail) return detail;
  switch (status) {
    case 401:
      return tr("Session expirée", "Session expired");
    case 403:
      return tr("Accès refusé", "Access denied");
    case 404:
      return tr("Ressource introuvable", "Resource not found");
    case 500:
      return tr("Erreur interne du serveur", "Internal server error");
    default:
      return `API ${status}`;
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public payload: unknown,
  ) {
    super(errorMessage(status, payload));
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
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Réponse non-JSON (typiquement une page HTML 502 d'un reverse proxy) :
      // on lève une ApiError exploitable plutôt qu'un SyntaxError brut.
      throw new ApiError(res.status, { raw: text.slice(0, 200) });
    }
  }
  if (!res.ok) {
    // Session expirée : on renvoie l'admin au login plutôt qu'un toast « API 401 ».
    // Exceptions : les endpoints d'auth (le formulaire de login doit afficher sa
    // propre erreur) et le mode démo (aucun backend, la « session » est simulée).
    if (res.status === 401 && !path.startsWith("/api/auth/") && !DEMO) {
      navigation.toLogin();
    }
    throw new ApiError(res.status, data);
  }
  return data as T;
}

/**
 * Point d'indirection de navigation : jsdom interdit de stubber
 * `window.location.assign` directement — les tests espionnent cet objet.
 */
export const navigation = {
  toLogin: () => {
    // Ceinture anti-boucle : si le login lui-même déclenche des 401 en rafale
    // (backend fail-closed sans mot de passe admin), on ne recharge pas en boucle.
    // sessionStorage survit au rechargement complet déclenché par assign().
    const KEY = "itsm.login-redirect-at";
    const last = Number(sessionStorage.getItem(KEY) ?? "0");
    if (Date.now() - last < 5_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
    window.location.assign(LOGIN_PATH);
  },
};

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

// ── Types (miroir des modèles backend) ───────────────────────────────────────
export const APP_VERSION = "0.9.45";

// Liens projet / auteur (widget flottant + indicateur de version).
export const AUTHOR_NAME = "Théo M.";
export const GITHUB_URL = "https://github.com/WicaebethTheo/itsm-modern-ai";
export const BUYMEACOFFEE_URL = "https://buymeacoffee.com/twicaebeth";

export type LlmProvider = "mistral" | "openai" | "ollama" | "anthropic";

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  mistral: "Mistral EU (souverain)",
  openai: "OpenAI",
  ollama: "Ollama (local)",
  anthropic: "Anthropic (Claude)",
};

export type RefKind = "category" | "entity" | "technician" | "group";

export type GlpiApiVersion = "legacy" | "v2";

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
  // Partie publique (toujours renvoyée — l'installeur sonde cet endpoint sans auth).
  ok: boolean;
  version: string;
  polling_enabled: boolean;
  // Partie enrichie : renvoyée UNIQUEMENT avec une session admin (la page Status est
  // derrière RequireAuth, mais les champs restent optionnels côté type).
  polling_interval_seconds?: number;
  whitelist_loaded?: boolean;
  categories_count?: number;
  technicians_count?: number;
  llm_calls_total?: number;
  cost_eur_last_24h?: number;
  cost_cap_eur_per_day?: number;
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
  glpi_api_version: GlpiApiVersion | null;
  glpi_v2_base_url: string | null;
  glpi_oauth_client_id: string | null;
  glpi_oauth_username: string | null;
  glpi_oauth_scope: string | null;
  glpi_oauth_client_secret_set: boolean;
  glpi_oauth_password_set: boolean;
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
  glpi_api_version?: GlpiApiVersion;
  glpi_v2_base_url?: string;
  glpi_oauth_client_id?: string;
  glpi_oauth_username?: string;
  glpi_oauth_scope?: string;
  glpi_oauth_client_secret?: string;
  glpi_oauth_password?: string;
  llm_api_key?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
}

/** Aperçu du compte GLPI sous lequel le bot agit (legacy = token, v2 = compte OAuth). */
export interface GlpiAccount {
  api_version: GlpiApiVersion;
  configured: boolean; // identifiants présents (un connecteur a pu être construit)
  account: string | null; // nom affichable, null si indéterminé/injoignable
  username: string; // identifiant de connexion GLPI
  profile: string; // profil/rôle GLPI actif
  email: string;
  has_picture: boolean; // une photo est-elle récupérable via /api/glpi/avatar ?
}

/** URL de la photo de profil du compte bot (proxy backend ; 404 → fallback initiales). */
export const GLPI_AVATAR_URL = "/api/glpi/avatar";

/** Scopes OAuth GLPI 11 disponibles (sélection multiple côté UI). */
export const GLPI_OAUTH_SCOPES = [
  "api",
  "user",
  "email",
  "inventory",
  "status",
  "graphql",
] as const;

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

export interface RetentionView {
  enabled: boolean;
  decisions_days: number;
  llm_calls_days: number;
  hour_utc: number;
  last_run_at: string | null;
  last_decisions_deleted: number | null;
  last_llm_calls_deleted: number | null;
  last_run_by: string | null; // "scheduler" pour le job auto, sinon IP de l'admin
}

export interface RetentionUpdate {
  enabled?: boolean;
  decisions_days?: number;
  llm_calls_days?: number;
  hour_utc?: number;
}

export interface PurgeRunResult {
  decisions_deleted: number;
  llm_calls_deleted: number;
  ran_at: string;
  view: RetentionView;
}

export interface SandboxResult {
  accepted: boolean;
  reason: string;
  category: number | null;
  category_name?: string | null; // libellé GLPI résolu (sinon on affiche l'id)
  priority: number | null;
  technician_id: number | null;
  technician_name?: string | null; // nom GLPI du technicien routé
  group_id: number | null;
  group_name?: string | null; // nom GLPI du groupe routé
  confidence: number | null;
  draft: string | null;
}

// ── Licence Supporter (open-core) ────────────────────────────────────────────

export type LicenseEdition = "community" | "supporter";

export interface LicenseFeature {
  key: string; // "pii_advanced" | "multi_entity" | "scheduled_exports"
  label_fr: string;
  label_en: string;
  description_fr: string;
  description_en: string;
  installed: boolean; // code présent dans l'image (Supporter)
  entitled: boolean; // autorisé par la licence
  active: boolean; // installed && entitled (= réellement débloqué)
}

export interface LicenseView {
  edition: LicenseEdition;
  valid: boolean;
  customer: string | null;
  issued_at: string | null; // "YYYY-MM-DD"
  expires_at: string | null; // "YYYY-MM-DD"
  error: string | null; // raison si invalide (ex. "licence expirée", "signature invalide")
  features: LicenseFeature[];
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  check_enabled: boolean; // une URL de vérification (opt-in) est-elle configurée ?
  latest_notes: string | null; // notes de release de la dernière version
  runtime: string; // "docker" (conteneur) ou "host" (installé direct sur la machine)
}

/**
 * Commande de mise à jour à lancer sur l'hôte, selon le runtime détecté par le
 * backend. Partagée par la topbar (Layout) et la carte « Mise à jour » (Store)
 * pour ne jamais proposer `install.sh` à un déploiement Docker (et vice-versa).
 */
export function updateCommand(runtime: string | undefined): string {
  return runtime === "docker"
    ? "docker compose pull && docker compose up -d"
    : "./install.sh --update";
}

// ── Confidentialité / DPO ─────────────────────────────────────────────────────
export interface PiiCategory {
  key: string;
  label_fr: string;
  label_en: string;
  example: string;
  scope: "community" | "supporter" | "roadmap"; // roadmap = capacité pas encore livrée
  active: boolean; // réellement masqué dans l'état courant
}
export interface PrivacyView {
  edition_advanced: boolean;
  categories: PiiCategory[];
  retention_decisions_days: number;
  retention_llm_calls_days: number;
  llm_calls_count: number;
}
export interface MaskTestOut {
  masked: string;
  counts: Record<string, number>;
}

// ── Coûts & quotas ────────────────────────────────────────────────────────────
export interface CostView {
  cost_cap_eur_per_day: number; // 0 = pas de plafond
  spent_eur_last_24h: number;
  pct_of_cap: number | null;
  over_cap: boolean;
  llm_calls_total: number;
  price_input_per_mtok: number;
  price_output_per_mtok: number;
  currency: string;
}

/** Rapport DPO téléchargeable (Markdown) — lien direct (téléchargement). */
export const DPO_REPORT_URL = "/api/privacy/report.md";

/** Mode démo : soit un build dédié (`VITE_DEMO=true`, ex. sous-domaine demo.*, servi à la
 *  racine), soit l'app servie sous /demo (démo in-product). Dans les deux cas, toutes les
 *  données sont simulées (demo.ts) — aucun backend requis. */
export const DEMO =
  import.meta.env.VITE_DEMO === "true" ||
  (typeof window !== "undefined" &&
    window.location.pathname.replace(/\/+$/, "").startsWith("/demo"));

/** Chemin absolu de la page de login — tient compte du basename démo (cf. App.tsx :
 *  build démo dédié servi à la racine → /login ; démo in-product → /demo/login). */
export const LOGIN_PATH = import.meta.env.VITE_DEMO !== "true" && DEMO ? "/demo/login" : "/login";

const ok = <T>(v: T): Promise<T> => Promise.resolve(v);

// ── Endpoints regroupés par domaine ──────────────────────────────────────────
export const Api = {
  authStatus: () => (DEMO ? ok(demo.authStatus) : api.get<AuthStatus>("/api/auth/status")),
  // En mode démo : AUCUN appel réseau. Un visiteur qui confond la démo publique avec sa
  // propre instance enverrait sinon un vrai mot de passe admin sur le réseau (le serveur
  // statique de la démo ne doit jamais le voir). On renvoie un statut authentifié simulé.
  login: (password: string) =>
    DEMO ? ok(demo.authStatus) : api.post<AuthStatus>("/api/auth/login", { password }),
  logout: () => (DEMO ? ok(demo.authStatus) : api.post<AuthStatus>("/api/auth/logout")),

  health: () => (DEMO ? ok(demo.health) : api.get<Health>("/health")),
  status: () => (DEMO ? ok(demo.status) : api.get<EngineStatus>("/api/status")),
  metrics: () => (DEMO ? ok(demo.metrics) : api.get<Metrics>("/api/metrics")),
  operationalMetrics: () =>
    DEMO ? ok(demo.operational) : api.get<OperationalView>("/api/operational-metrics"),

  getConfig: () => (DEMO ? ok(demo.config) : api.get<ConfigView>("/api/config")),
  updateConfig: (body: ConfigUpdate) =>
    DEMO ? ok(demo.config) : api.post<ConfigView>("/api/config", body),
  glpiWhoami: () => (DEMO ? ok(demo.glpiAccount) : api.get<GlpiAccount>("/api/glpi/whoami")),
  resetGlpi: () => (DEMO ? ok({ ok: true }) : api.post<{ ok: boolean }>("/api/glpi/reset")),

  // Licence Supporter (open-core) — activation/réinitialisation hors-ligne.
  version: () => (DEMO ? ok(demo.version) : api.get<VersionInfo>("/api/version")),

  // Confidentialité / DPO + coûts.
  privacy: () => (DEMO ? ok(demo.privacy) : api.get<PrivacyView>("/api/privacy")),
  testMask: (text: string) =>
    DEMO
      ? ok({ masked: text.replace(/\S+@\S+/g, "[EMAIL]"), counts: {} } as MaskTestOut)
      : api.post<MaskTestOut>("/api/privacy/test-mask", { text }),
  cost: () => (DEMO ? ok(demo.cost) : api.get<CostView>("/api/cost")),

  getLicense: () => (DEMO ? ok(demo.license) : api.get<LicenseView>("/api/license")),
  setLicense: (key: string) =>
    DEMO ? ok(demo.license) : api.post<LicenseView>("/api/license", { key }),
  deleteLicense: () => (DEMO ? ok(demo.license) : api.del<LicenseView>("/api/license")),

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

  // Automatisations — rétention RGPD (Journal + appels LLM).
  retention: () =>
    DEMO ? ok(demo.retention) : api.get<RetentionView>("/api/automations/retention"),
  updateRetention: (body: RetentionUpdate) =>
    DEMO
      ? ok({ ...demo.retention, ...body } as RetentionView)
      : api.patch<RetentionView>("/api/automations/retention", body),
  runRetention: () =>
    DEMO
      ? ok({
          decisions_deleted: 0,
          llm_calls_deleted: 0,
          ran_at: new Date().toISOString(),
          view: demo.retention,
        } as PurgeRunResult)
      : // Garde-fou : le backend exige confirm="PURGER" (action destructive).
        api.post<PurgeRunResult>("/api/automations/retention/run", { confirm: "PURGER" }),

  sandbox: (content: string, title = "") =>
    DEMO
      ? ok({
          accepted: true,
          reason: "accepted",
          category: 1,
          category_name: "Compte / Authentification",
          priority: 3,
          technician_id: 11,
          technician_name: "Sylvain Martin",
          group_id: null,
          group_name: null,
          confidence: 0.9,
          draft: "Bonjour, nous avons bien reçu votre demande et la prenons en charge.",
        } satisfies SandboxResult)
      : api.post<SandboxResult>("/api/sandbox", { title, content }),
};
