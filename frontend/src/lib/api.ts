/**
 * Client API typé — point d'entrée UNIQUE vers le moteur (backend REST).
 *
 * Tout ajout d'endpoint backend se reflète ici (types + méthode), ce qui garde
 * l'UI facile à étendre : les pages n'appellent jamais `fetch` directement.
 */

import { demo } from "./demo";
import { tr } from "./i18n";

/**
 * Messages de validation GÉNÉRIQUES de Pydantic v2 : ils décrivent la contrainte, jamais ce
 * que l'exploitant doit faire, et ils arrivent en anglais dans une console française (« Input
 * should be less than or equal to 5 »). Les afficher tels quels n'est pas plus actionnable
 * qu'« API 422 » — on les laisse donc tomber au profit du libellé traduit par status, en ne
 * gardant QUE les messages écrits par nos validateurs (anti-SSRF, cohérence de config).
 */
const VALIDATION_GENERIQUE = [
  /^Input should /i,
  /^Field required$/i,
  /^Value is not a valid /i,
  /^String should /i,
  /^Ensure this value /i,
  /^Extra inputs are not permitted$/i,
  /^Unable to parse /i,
  /^Assertion failed/i,
];

/** Au-delà, la cause utile est noyée : on borne au lieu de déverser tout le rapport 422. */
const MAX_DETAILS = 3;

/**
 * Nom du champ mis en cause par une erreur 422 FastAPI : `loc` vaut `["body", "glpi_base_url"]`.
 * Sans lui, « Field required » ne dit pas QUEL champ manque — inactionnable.
 */
function champFautif(item: Record<string, unknown>): string | null {
  const loc = item.loc;
  if (!Array.isArray(loc)) return null;
  // On saute le conteneur (`body`, `query`, `path`) : c'est du vocabulaire HTTP, pas un champ.
  const parts = loc.filter(
    (p): p is string => typeof p === "string" && !["body", "query", "path", "header"].includes(p),
  );
  return parts.length > 0 ? parts.join(".") : null;
}

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
    // 422 : FastAPI sérialise les erreurs de validation en TABLEAU. C'est là que
    // ressortent les seuls diagnostics actionnables de l'enregistrement — les messages
    // anti-SSRF des validateurs d'URL (`api/routes/config.py`). Sans ce cas, ils se
    // perdaient et l'exploitant lisait « API 422 » à la place de la cause.
    if (Array.isArray(detail)) {
      const messages = detail
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as Record<string, unknown>;
          if (typeof item.msg !== "string" || !item.msg) return null;
          // Pydantic v2 préfixe les ValueError levées par un validateur ; le préfixe
          // est du bruit pour l'exploitant, le message utile est derrière.
          const msg = item.msg.replace(/^Value error, /, "").trim();
          if (!msg || VALIDATION_GENERIQUE.some((r) => r.test(msg))) return null;
          const champ = champFautif(item);
          return champ ? `${champ} : ${msg}` : msg;
        })
        .filter((m): m is string => !!m)
        .slice(0, MAX_DETAILS);
      if (messages.length > 0) return messages.join(" · ");
    }
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
    /** Secondes à attendre (en-tête `Retry-After`) — renseigné sur les 429 anti-brute-force. */
    public retryAfter?: number,
  ) {
    super(errorMessage(status, payload));
  }
}

/**
 * Code machine de l'erreur (`detail.code`), quand le backend en pose un.
 * Les pages d'auth s'en servent pour distinguer « email invalide » de « mot de passe
 * trop court » sur un même 422 — le message, lui, reste destiné à l'humain.
 */
export function errorCode(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const p = e.payload;
  if (p && typeof p === "object" && "detail" in p) {
    const detail = (p as { detail?: unknown }).detail;
    if (detail && typeof detail === "object" && "code" in detail) {
      const c = (detail as { code?: unknown }).code;
      if (typeof c === "string" && c) return c;
    }
  }
  return null;
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
    // `Retry-After` (429 anti-brute-force) : le corps ne porte QUE le message, le délai
    // vit dans l'en-tête. Sans le remonter ici, l'UI ne peut ni décompter ni rouvrir le
    // formulaire au bon moment — elle inventerait un délai, ou ferait attendre à vide.
    const retryAfter = Number(res.headers.get("Retry-After"));
    throw new ApiError(
      res.status,
      data,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
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

/**
 * Deuxième ceinture anti-boucle, sur le même principe que `navigation.toLogin` :
 * `/setup` renvoie vers `/login` quand le moteur répond 409 « un compte existe déjà »,
 * or `/login` renvoie vers `/setup` quand le statut dit `setup_required`. Si les deux
 * réponses se contredisent — statut en cache, réplique en retard, second onglet qui a
 * créé le compte —, les deux pages se renvoient la balle indéfiniment.
 *
 * Le 409 fait FOI : il vient de l'écriture elle-même, pas d'une lecture. On le mémorise
 * donc pour l'onglet en cours, et `/login` cesse de proposer l'installation. La marque ne
 * survit pas à la fermeture de l'onglet (sessionStorage) : une instance réellement vierge
 * retrouve son écran d'installation à la visite suivante.
 */
const SETUP_SETTLED_KEY = "itsm.setup-settled";

export const setupSettled = {
  mark: () => sessionStorage.setItem(SETUP_SETTLED_KEY, "1"),
  get: () => sessionStorage.getItem(SETUP_SETTLED_KEY) === "1",
};

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

// ── Types (miroir des modèles backend) ───────────────────────────────────────
export const APP_VERSION = "0.9.83";

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

/** Identité de l'unique compte administrateur (réponse de `GET /api/auth/me`). */
export interface AdminIdentity {
  email: string;
  display_name: string | null;
}

export interface AuthStatus {
  authenticated: boolean;
  auth_configured: boolean;
  /**
   * Aucun compte administrateur n'existe encore → l'installation n'est pas terminée et
   * l'UI doit envoyer sur `/setup`. Optionnel : un moteur antérieur à la page
   * d'installation ne renvoie pas ce champ, et `undefined` (faux) est le bon défaut —
   * on ne propose jamais de créer un compte sur une instance qui n'en sait rien.
   */
  setup_required?: boolean;
}

/** Création du compte administrateur (première installation). */
export interface SetupRequest {
  email: string;
  password: string;
  display_name?: string;
}

/** Longueur minimale imposée par le moteur (`MIN_ADMIN_CHARS`, api/security.py). */
export const MIN_PASSWORD_CHARS = 8;

export interface Health {
  status: "ok" | "degraded";
  glpi: { configured: boolean; reachable: boolean; version?: string | null };
  llm: { configured: boolean; reachable: boolean | null };
}

/** Le corps d'un `/health` dégradé (HTTP 503) est un Health exploitable — pas une erreur. */
function isHealth(payload: unknown): payload is Health {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  const glpi = p.glpi as Record<string, unknown> | undefined;
  const llm = p.llm as Record<string, unknown> | undefined;
  return (
    typeof p.status === "string" &&
    !!glpi &&
    typeof glpi === "object" &&
    typeof glpi.configured === "boolean" &&
    !!llm &&
    typeof llm === "object" &&
    typeof llm.configured === "boolean"
  );
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
  // État du DERNIER cycle de polling (observabilité) — cf. `readPollCycle`.
  // Contrat : `last_poll` est OMIS si le moteur ne l'expose pas encore, `null` si aucun
  // cycle n'a jamais tourné (état de première classe, symptôme n°1), sinon l'objet.
  // Les clés à plat `poll_last_*` (miroir des clés runtime) restent tolérées à la lecture.
  last_poll?: PollCycle | null;
  poll_last_run_at?: string | null;
  poll_last_fetched?: number | null;
  poll_last_processed?: number | null;
  poll_last_skipped_done?: number | null;
  poll_last_skipped_scope?: number | null;
  poll_last_errors?: number | null;
  poll_last_error_message?: string | null;
}

/**
 * Résumé du dernier cycle de polling, normalisé pour l'UI.
 *
 * Répond à la seule question qui compte en exploitation : « le moteur a-t-il tourné, et
 * qu'a-t-il vu ? ». `fetched` = tickets lus dans GLPI, `processed` = tickets triés,
 * `skipped_done` = déjà traités, `skipped_scope` = hors périmètre, `errors` = échecs du
 * cycle. Tous les champs sont nullables : un moteur qui n'a jamais tourné n'a rien à dire.
 */
export interface PollCycle {
  has_run: boolean | null; // le moteur a-t-il déjà bouclé au moins une fois ?
  run_at: string | null; // ISO 8601
  fetched: number | null;
  processed: number | null;
  skipped_done: number | null;
  skipped_scope: number | null;
  errors: number | null;
  error_message: string | null;
}

// Noms acceptés pour chaque champ du cycle. Le bloc est en cours de déploiement côté
// moteur : plutôt que de casser la page au moindre renommage, on lit le premier alias
// présent. Le 1er de chaque liste est le nom des clés runtime (`poll_last_*`).
const POLL_CYCLE_ALIASES: Record<keyof PollCycle, string[]> = {
  has_run: ["poll_last_has_run", "has_run", "ran"],
  run_at: ["poll_last_run_at", "run_at", "ran_at", "last_run_at", "started_at", "at", "timestamp"],
  fetched: ["poll_last_fetched", "fetched", "tickets_fetched", "seen"],
  processed: ["poll_last_processed", "processed", "triaged"],
  skipped_done: ["poll_last_skipped_done", "skipped_done", "already_done"],
  skipped_scope: ["poll_last_skipped_scope", "skipped_scope", "out_of_scope"],
  errors: ["poll_last_errors", "errors", "error_count"],
  error_message: ["poll_last_error_message", "error_message", "last_error", "error"],
};

// Sous-objets où le bloc peut être imbriqué (sinon les clés sont à la racine du statut).
const POLL_CYCLE_CONTAINERS = ["last_poll", "last_cycle", "last_run", "poll_last", "poll"];

/** Nombre tolérant : le backend peut renvoyer les compteurs runtime en texte (« 12 »). */
function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Écritures d'un booléen sérialisé en chaîne, partagées par `asBoolean` et `asBool` : la
 * config runtime stocke `"1"`/`"0"`, les réponses JSON `"true"`/`"false"`, et les formulaires
 * historiques `"yes"`/`"on"`. Une seule liste, sinon les deux lecteurs divergent.
 */
const BOOLEENS_VRAIS = ["1", "true", "yes", "on", "vrai"];
const BOOLEENS_FAUX = ["0", "false", "no", "off", "faux"];

/**
 * Booléen tolérant : un moteur plus ancien peut rendre le drapeau en texte JSON.
 *
 * MÊMES écritures qu'`asBool` (même fichier, même produit) : le premier alias de `has_run`
 * est une CLÉ RUNTIME, et la convention de sérialisation de la config runtime est `"1"`/`"0"`
 * — n'accepter que `"true"`/`"false"` ici aurait lu le drapeau comme ABSENT le jour où le
 * moteur passe par cette voie, et la page Statut serait retombée sur la pastille verte du
 * symptôme n°1. Différence assumée avec `asBool` : trois états (`null` = « rien à affirmer »)
 * au lieu de deux, parce qu'ici l'absence d'information n'est pas « faux ».
 */
function asBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (BOOLEENS_VRAIS.includes(s)) return true;
    if (BOOLEENS_FAUX.includes(s)) return false;
  }
  return null;
}

/**
 * Trois états DISTINCTS du dernier cycle — les confondre est précisément ce qui rendait la
 * page Status non diagnostique :
 * - `unavailable` : le moteur n'expose pas le bloc (version antérieure, ou réponse publique
 *   non authentifiée) → l'UI ne sait rien, elle doit le dire plutôt qu'afficher du vert ;
 * - `never` : `last_poll` vaut `null` → le worker n'a JAMAIS bouclé, même affiché « En
 *   marche » (symptôme n°1) ;
 * - `ran` : un cycle a tourné, avec ses compteurs.
 */
export type PollCycleState =
  | { kind: "unavailable" }
  | { kind: "never" }
  | { kind: "ran"; cycle: PollCycle };

/**
 * Extrait le bloc « dernier cycle » d'un statut, quelle que soit la forme retenue par le
 * moteur (objet `last_poll` — contrat courant — ou clés à plat `poll_last_*`).
 */
export function readPollCycle(status: EngineStatus | null | undefined): PollCycleState {
  if (!status) return { kind: "unavailable" };
  const root = status as unknown as Record<string, unknown>;
  const areas: Record<string, unknown>[] = [];
  let containerSeen = false;
  for (const key of POLL_CYCLE_CONTAINERS) {
    const nested = root[key];
    if (nested === undefined) continue; // clé absente = le moteur n'expose pas le bloc
    containerSeen = true; // clé présente à `null` = aucun cycle n'a jamais tourné
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      areas.push(nested as Record<string, unknown>);
    }
  }
  areas.push(root); // le bloc imbriqué prime sur d'éventuelles clés à plat
  const find = (aliases: string[]): unknown => {
    for (const area of areas) {
      for (const alias of aliases) {
        if (area[alias] != null) return area[alias];
      }
    }
    return null;
  };
  // Verdict EXPLICITE du moteur, à lire avant tout : `LastPoll.has_run` (routes/status.py)
  // est un booléen non nul, donc il survit à `response_model_exclude_none=True`. Les
  // compteurs, eux, valent 0 — et non `null` — quand aucun cycle n'a tourné : s'en remettre
  // à eux classait « jamais exécuté » en « a tourné » (0 !== null), et la page affichait une
  // pastille verte sur un moteur qui n'avait jamais bouclé. C'est le symptôme n°1.
  const hasRun = asBoolean(find(POLL_CYCLE_ALIASES.has_run));
  const cycle: PollCycle = {
    has_run: hasRun,
    run_at: asText(find(POLL_CYCLE_ALIASES.run_at)),
    fetched: asNumber(find(POLL_CYCLE_ALIASES.fetched)),
    processed: asNumber(find(POLL_CYCLE_ALIASES.processed)),
    skipped_done: asNumber(find(POLL_CYCLE_ALIASES.skipped_done)),
    skipped_scope: asNumber(find(POLL_CYCLE_ALIASES.skipped_scope)),
    errors: asNumber(find(POLL_CYCLE_ALIASES.errors)),
    error_message: asText(find(POLL_CYCLE_ALIASES.error_message)),
  };
  if (hasRun === false) return { kind: "never" };
  if (hasRun === true) return { kind: "ran", cycle };
  // Moteur qui n'annonce pas `has_run` (clés à plat d'une version antérieure) : on retombe
  // sur les compteurs, en excluant `has_run` lui-même du test — sinon il se répondrait.
  const { has_run: _hasRun, ...counters } = cycle;
  if (Object.values(counters).some((v) => v !== null)) return { kind: "ran", cycle };
  if (containerSeen) return { kind: "never" };
  // `/api/status` est sérialisé avec `response_model_exclude_none=True` : le moteur OMET
  // `last_poll` au lieu de l'écrire à `null`. « Aucun cycle exécuté » arriverait donc sur
  // le fil comme une simple absence de champ — or c'est le symptôme n°1 à rendre visible.
  // On lève l'ambiguïté quand c'est sûr : réponse ENRICHIE (session admin, sinon le bloc
  // est de toute façon filtré) ET moteur de la même version que cette UI — l'édition est
  // unique, une seule image, front et back bumpés ensemble : le bloc EST donc implémenté.
  // Version différente (dev, proxy vers un moteur plus ancien) → on n'affirme rien.
  const enriched = status.polling_interval_seconds != null || status.llm_calls_total != null;
  if (enriched && status.version === APP_VERSION) return { kind: "never" };
  return { kind: "unavailable" };
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
  // Tarifs LLM (EUR/Mtok) surchargeables a chaud : cost cap juste apres bascule de provider.
  llm_price_input_per_mtok: string | null;
  llm_price_output_per_mtok: string | null;
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
  llm_price_input_per_mtok?: number;
  llm_price_output_per_mtok?: number;
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
  return v != null && BOOLEENS_VRAIS.includes(v.trim().toLowerCase());
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
  /**
   * Un acteur de repli a été assigné MALGRÉ le refus (colonne distincte de `applied`,
   * cf. persistence/tables.py). Sans ce champ, un « à trier » repris par le repli et un
   * « à trier » resté orphelin sont indiscernables — or c'est exactement la distinction
   * qui dit à l'exploitant où il doit mettre la main. Optionnel : un moteur antérieur
   * ne le renvoie pas, et `undefined` se lit comme « on ne sait pas », pas comme « non ».
   */
  fallback_applied?: boolean;
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
  /** Domaines de compétence cochés (clés du catalogue `/api/skills`). */
  skill_tags: string[];
  mode?: ExecutionMode | null;
  auto_min_confidence?: number | null;
  /** Cible de repli (entités) : acteur assigné quand le garde-fou refuse une Décision. */
  fallback_group_id?: number | null;
  fallback_technician_id?: number | null;
  /**
   * Horodatage du dernier scan GLPI ayant touché cette ligne (ISO 8601 UTC). Sert à dire
   * la FRAÎCHEUR du cache : sans lui, un technicien parti il y a trois mois reste dans la
   * liste sans que rien ne signale que le référentiel date. Optionnel : un moteur
   * antérieur ne le renvoie pas, et l'UI n'affirme alors rien.
   */
  updated_at?: string | null;
}

export interface ModeItem {
  ext_id: number;
  mode: ExecutionMode | null;
  auto_min_confidence?: number | null;
  /** Groupe PRIORITAIRE sur technicien : il encaisse une absence sans configuration. */
  fallback_group_id?: number | null;
  fallback_technician_id?: number | null;
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

/** Domaine cochable du catalogue produit — servi par l'API, jamais dupliqué côté client. */
export interface SkillDomain {
  key: string;
  label_fr: string;
  label_en: string;
  hint_fr: string;
}

/**
 * Couverture d'un domaine par les acteurs ÉLIGIBLES — diagnostic, pas statistique.
 * Compteurs distincts : un groupe absorbe une absence, un technicien seul non.
 * Aucun acteur n'est nommé (anti-mouchard).
 */
export interface SkillCoverage {
  key: string;
  label_fr: string;
  label_en: string;
  technicians: number;
  groups: number;
}

/** Absence déclarée d'un technicien (routage). Bornes INCLUSES, granularité jour. */
export interface AbsenceItem {
  technician_ext_id: number;
  start_date: string; // ISO YYYY-MM-DD
  end_date: string;
  replacement_ext_id?: number | null;
  note?: string;
}

export interface AbsenceView extends AbsenceItem {
  id: number;
  technician_name: string;
  replacement_name: string;
  /** Couvre la journée en cours, dans le fuseau local configuré côté moteur. */
  active: boolean;
}

export interface EligibilityItem {
  ext_id: number;
  eligible: boolean;
  skills: string;
  /** Omis = le serveur PRÉSERVE la sélection existante ; `[]` la vide. */
  skill_tags?: string[];
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
  // Coût réel de l'essai : la sandbox est déjà comptée dans le plafond (routes/sandbox.py)
  // mais ne disait pas ce qu'elle venait de dépenser — deux chiffres décisifs avant
  // d'autoriser le moteur sur un flux réel. Optionnels : moteur antérieur = absents.
  model?: string | null;
  cost_eur?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
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
  /**
   * Module annoncé mais sans surface d'usage. Une licence l'« autorise » déjà, donc sans
   * ce drapeau l'UI affichait « Débloqué » en vert pour quelque chose qui ne fait encore
   * rien — le client paie et voit une promesse peinte en réussite.
   */
  coming_soon?: boolean;
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
  login: (email: string, password: string) =>
    DEMO ? ok(demo.authStatus) : api.post<AuthStatus>("/api/auth/login", { email, password }),
  // Même garde qu'au login, et elle compte DOUBLE ici : l'écran d'installation est celui
  // où l'on choisit un mot de passe qu'on réutilisera. Un visiteur de la démo publique qui
  // le croirait « sa » console enverrait ce secret tout neuf à un serveur statique.
  setup: (body: SetupRequest) =>
    DEMO ? ok(demo.authStatus) : api.post<AuthStatus>("/api/auth/setup", body),
  logout: () => (DEMO ? ok(demo.authStatus) : api.post<AuthStatus>("/api/auth/logout")),
  /**
   * Identité du compte connecté. Route SÉPARÉE et authentifiée, à ne jamais fusionner
   * dans `/api/auth/status` : celle-ci est publique, et y faire figurer l'adresse
   * offrirait à un anonyme la moitié du couple à deviner (cf. routes/auth.py).
   */
  me: () => (DEMO ? ok(demo.me) : api.get<AdminIdentity>("/api/auth/me")),
  /**
   * Change le mot de passe de l'unique administrateur. Le moteur incrémente la génération
   * de session : TOUTES les sessions tombent, y compris la nôtre — l'appelant doit donc
   * renvoyer vers `/login` après un succès.
   */
  changePassword: (current_password: string, new_password: string) =>
    DEMO
      ? ok({ ok: true })
      : api.post<{ ok: boolean }>("/api/auth/password", { current_password, new_password }),

  // `probe` déclenche une VRAIE requête sortante vers le fournisseur LLM (facturée, et
  // réservée aux sessions authentifiées côté moteur) : jamais au chargement d'une page,
  // uniquement sur action explicite de l'admin (bouton « Tester la connexion »).
  health: async (probe = false): Promise<Health> => {
    if (DEMO) return probe ? demo.healthProbed : demo.health;
    try {
      return await api.get<Health>(probe ? "/health?probe=true" : "/health");
    } catch (e) {
      // `/health` répond 503 quand GLPI (ou la sonde LLM) échoue, MAIS le corps est un
      // Health complet : c'est le diagnostic lui-même. Le remonter en exception effaçait
      // l'information utile derrière un « API 503 » — on renvoie le corps tel quel.
      if (e instanceof ApiError && isHealth(e.payload)) return e.payload;
      throw e;
    }
  },
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
  skillCatalog: () => api.get<SkillDomain[]>("/api/skills"),
  skillCoverage: () => api.get<SkillCoverage[]>("/api/skills/coverage"),
  absences: () => api.get<AbsenceView[]>("/api/absences"),
  saveAbsences: (items: AbsenceItem[]) => api.put<AbsenceView[]>("/api/absences", items),
  saveTechnicians: (items: EligibilityItem[]) =>
    DEMO ? ok(demo.technicians) : api.put<RefItem[]>("/api/technicians", items),
  saveGroups: (items: EligibilityItem[]) =>
    DEMO ? ok(demo.groups) : api.put<RefItem[]>("/api/groups", items),
  getScope: () => (DEMO ? ok(demo.scope) : api.get<Scope>("/api/scope")),
  setScope: (scope: Scope) => (DEMO ? ok(scope) : api.put<Scope>("/api/scope", scope)),
  saveModes: (items: ModeItem[]) =>
    DEMO ? ok([] as RefItem[]) : api.put<RefItem[]>("/api/modes", items),

  decisions: (limit?: number) =>
    DEMO
      ? ok(demo.decisions)
      : api.get<DecisionEntry[]>(`/api/decisions${limit ? `?limit=${limit}` : ""}`),
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
          // Le moteur renvoie TOUJOURS ce qu'un essai vient de coûter (routes/sandbox.py) :
          // sans ces trois champs, la démo masquait le bloc de coût de la Sandbox — soit
          // exactement l'écran qu'un exploitant regarde avant d'autoriser un flux réel.
          model: "mistral-large-latest",
          cost_eur: 0.0021,
          prompt_tokens: 812,
          completion_tokens: 143,
        } satisfies SandboxResult)
      : api.post<SandboxResult>("/api/sandbox", { title, content }),
};
