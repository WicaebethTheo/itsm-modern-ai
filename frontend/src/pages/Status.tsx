import { type ReactNode, useCallback, useState } from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dot, type DotTone } from "@/components/ui/dot";
import { useResource } from "@/hooks/useResource";
import { Api, type PollCycle, type PollCycleState, readPollCycle } from "@/lib/api";
import { useT } from "@/lib/i18n";

type T = (fr: string, en: string) => string;

function ServicePanel({
  name,
  state,
  meta,
  tone,
  children,
}: {
  name: string;
  state: string;
  meta: string;
  tone: DotTone;
  children?: ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">{name}</span>
        <Dot tone={tone} />
      </div>
      <div className="mt-2 text-[18px] font-semibold tracking-tight">{state}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{meta}</div>
      {children}
    </Card>
  );
}

/**
 * Horodatage du moteur → Date. Le backend écrit de l'UTC ; si le marqueur de fuseau
 * manque (`2026-08-08T19:42:03`), `new Date` l'interpréterait en heure LOCALE et l'âge
 * affiché serait faux de plusieurs heures — on force le suffixe Z dans ce cas.
 */
export function parseEngineDate(value: string): Date | null {
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  const d = new Date(hasTz ? value : `${value.trim()}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Âge lisible : « il y a 42 s », « il y a 12 min », « il y a 3 h », « il y a 2 j ». */
export function formatAge(seconds: number, t: T): string {
  if (seconds < 1) return t("à l'instant", "just now");
  if (seconds < 60) {
    const v = Math.round(seconds);
    return t(`il y a ${v} s`, `${v} s ago`);
  }
  if (seconds < 3600) {
    const v = Math.round(seconds / 60);
    return t(`il y a ${v} min`, `${v} min ago`);
  }
  if (seconds < 86400) {
    const v = Math.round(seconds / 3600);
    return t(`il y a ${v} h`, `${v} h ago`);
  }
  const v = Math.round(seconds / 86400);
  return t(`il y a ${v} j`, `${v} d ago`);
}

/** Compteurs du cycle en une phrase : « 12 vus, 3 triés, 9 déjà traités, … ». */
function formatCounts(c: PollCycle, t: T): string {
  const n = (v: number | null) => (v == null ? "?" : String(v));
  const errors = c.errors ?? 0;
  return t(
    `${n(c.fetched)} vus, ${n(c.processed)} triés, ${n(c.skipped_done)} déjà traités, ${n(c.skipped_scope)} hors périmètre, ${n(c.errors)} erreur${errors > 1 ? "s" : ""}`,
    `${n(c.fetched)} seen, ${n(c.processed)} triaged, ${n(c.skipped_done)} already done, ${n(c.skipped_scope)} out of scope, ${n(c.errors)} error${errors > 1 ? "s" : ""}`,
  );
}

/**
 * Piste de diagnostic dérivée des compteurs — les 5 causes réelles de « aucun ticket
 * n'est trié » sont toutes lisibles ici, alors qu'aucune ne l'était dans les tuiles.
 */
export function cycleHint(c: PollCycle, t: T): string | null {
  if ((c.errors ?? 0) > 0) {
    return t(
      "Le dernier cycle a échoué : le moteur ne trie plus tant que la cause n'est pas levée.",
      "The last cycle failed: the engine stops triaging until the cause is fixed.",
    );
  }
  if (c.fetched === 0) {
    return t(
      "Aucun ticket lu dans GLPI. Causes usuelles : périmètre d'entités trop étroit, fenêtre de lecture trop courte, ou une règle métier GLPI qui affecte déjà les tickets avant le moteur.",
      "No ticket read from GLPI. Usual causes: entity scope too narrow, read window too short, or a GLPI business rule already assigning tickets before the engine.",
    );
  }
  if (c.fetched != null && c.fetched > 0 && c.processed === 0) {
    const scope = c.skipped_scope ?? 0;
    const done = c.skipped_done ?? 0;
    if (scope > 0 && scope >= done) {
      return t(
        "Tous les tickets lus sont hors périmètre : élargissez le périmètre (page Règles métier).",
        "Every ticket read is out of scope: widen the scope (Business rules page).",
      );
    }
    if (done > 0) {
      return t(
        "Tous les tickets lus étaient déjà traités : il n'y avait rien à trier — ce n'est pas une panne.",
        "Every ticket read was already handled: there was nothing to triage — this is not a failure.",
      );
    }
    return t(
      "Des tickets ont été lus mais aucun n'a été trié.",
      "Tickets were read but none were triaged.",
    );
  }
  return null;
}

/** Carte « dernier cycle » : l'information n°1 pour savoir si le moteur travaille. */
function LastCycleCard({
  cycleState,
  intervalSeconds,
  pollingEnabled,
  t,
  locale,
}: {
  cycleState: PollCycleState;
  intervalSeconds: number | null;
  pollingEnabled: boolean;
  t: T;
  locale: string;
}) {
  const title = t("Dernier cycle de polling", "Last polling cycle");

  if (cycleState.kind === "unavailable") {
    return (
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium">{title}</span>
          <Dot tone="muted" />
        </div>
        <div className="mt-2 text-[18px] font-semibold tracking-tight">
          {t("Non mesuré", "Not measured")}
        </div>
        <div className="mt-1 text-[12px] text-muted-foreground">
          {t(
            "Ce moteur ne remonte pas l'état de son dernier cycle : impossible de savoir d'ici s'il a réellement tourné.",
            "This engine does not report its last cycle: there is no way to tell from here whether it actually ran.",
          )}
        </div>
      </Card>
    );
  }

  if (cycleState.kind === "never") {
    return (
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium">{title}</span>
          <Dot tone={pollingEnabled ? "red" : "amber"} />
        </div>
        <div className="mt-2 text-[18px] font-semibold tracking-tight">
          {t("Aucun cycle exécuté", "No cycle has run")}
        </div>
        <div className="mt-1 text-[12px] text-muted-foreground">
          {pollingEnabled
            ? t(
                "Le worker est annoncé « En marche » mais n'a jamais bouclé une seule fois : aucun ticket ne peut être trié.",
                'The worker reports "Running" but has never completed a single loop: no ticket can be triaged.',
              )
            : t(
                "Le polling est en pause : c'est attendu tant qu'il n'est pas réactivé.",
                "Polling is paused: expected until it is re-enabled.",
              )}
        </div>
      </Card>
    );
  }

  const cycle = cycleState.cycle;
  const runAt = cycle.run_at ? parseEngineDate(cycle.run_at) : null;
  const ageSeconds = runAt ? Math.max(0, (Date.now() - runAt.getTime()) / 1000) : null;
  // « Trop ancien » = plus de 3 cycles manqués (plancher 5 min, pour ne pas crier au loup
  // sur un intervalle très court juste après un redémarrage).
  const staleAfter = Math.max((intervalSeconds ?? 60) * 3, 300);
  const stale = ageSeconds != null && ageSeconds > staleAfter;
  const failed = (cycle.errors ?? 0) > 0;
  const tone: DotTone = failed ? "red" : stale ? "amber" : "green";
  const hint = cycleHint(cycle, t);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">{title}</span>
        <Dot tone={tone} pulse={!failed && !stale} />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[18px] font-semibold tracking-tight">
          {ageSeconds != null ? formatAge(ageSeconds, t) : t("date inconnue", "unknown date")}
        </span>
        {stale && (
          <span className="text-[11px] font-medium text-warning">
            {t("cycle trop ancien", "cycle overdue")}
          </span>
        )}
      </div>
      <div className="mt-1 text-[12px]">{formatCounts(cycle, t)}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {runAt
          ? runAt.toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" })
          : t("horodatage absent", "no timestamp")}
        {intervalSeconds != null &&
          t(` · intervalle ${intervalSeconds} s`, ` · every ${intervalSeconds} s`)}
      </div>
      {stale && !failed && (
        <div className="mt-3">
          <Banner kind="warning">
            {t(
              "Le worker n'a pas bouclé depuis bien plus longtemps que son intervalle : vérifiez qu'il tourne (logs du conteneur) et que GLPI répond.",
              "The worker has not looped for far longer than its interval: check that it is running (container logs) and that GLPI answers.",
            )}
          </Banner>
        </div>
      )}
      {failed && (
        <div className="mt-3">
          <Banner kind="error">
            {cycle.error_message ??
              t("Erreur non détaillée par le moteur.", "No error detail reported by the engine.")}
          </Banner>
        </div>
      )}
      {hint && !failed && <div className="mt-2 text-[11.5px] text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export function Status() {
  const t = useT();
  const locale = t("fr-FR", "en-US");
  const status = useResource(useCallback(() => Api.status(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const s = status.data;
  const h = health.data;
  // Version d'API réellement configurée (comme Layout) — le méta ne doit pas être figé.
  const isV2 = cfg.data?.glpi_api_version === "v2";
  const loadError = status.error ?? health.error;

  // Sonde LLM : action EXPLICITE (appel sortant facturé, réservé aux sessions admin).
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<boolean | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const testLlm = useCallback(async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const probed = await Api.health(true);
      setProbeResult(probed.llm.reachable === true);
    } catch (e) {
      setProbeResult(null);
      setProbeError((e as Error).message);
    } finally {
      setProbing(false);
    }
  }, []);

  // Champs enrichis renvoyés seulement avec une session admin (la page est derrière
  // RequireAuth, mais on reste défensif : le type les déclare optionnels).
  const overCap =
    s?.cost_cap_eur_per_day != null &&
    s.cost_eur_last_24h != null &&
    s.cost_cap_eur_per_day > 0 &&
    s.cost_eur_last_24h >= s.cost_cap_eur_per_day;

  const cycleState = readPollCycle(s);
  const cycleNeverRan = cycleState.kind === "never";

  // Tuile « Base de données » : aucune sonde n'existe côté API. Le seul fait mesurable
  // est que /api/status a renvoyé ses compteurs — ils viennent de requêtes SQL réelles
  // (comptage des appels LLM, coût 24 h). Hors de ce cas, on n'affirme RIEN.
  const dbRead = s?.llm_calls_total != null;
  const dbState = status.error
    ? t("Inconnue", "Unknown")
    : dbRead
      ? t("Lecture OK", "Read OK")
      : t("Non mesurée", "Not measured");
  const dbMeta = status.error
    ? t("aucune réponse de l'API", "no answer from the API")
    : dbRead
      ? t("compteurs relus à l'ouverture de la page", "counters re-read when this page loaded")
      : t("aucune sonde exposée par l'API", "no probe exposed by the API");

  const llmProbed = probeResult !== null;
  const services: {
    name: string;
    state: string;
    meta: string;
    tone: DotTone;
    children?: ReactNode;
  }[] = [
    {
      name: t("Worker (moteur)", "Worker (engine)"),
      state: s?.polling_enabled ? t("En marche", "Running") : t("En pause", "Paused"),
      // Le flag `polling_enabled` ne prouve RIEN : le méta porte l'état réel des cycles.
      meta: cycleNeverRan
        ? t("aucun cycle exécuté à ce jour", "no cycle has ever run")
        : s?.polling_interval_seconds != null
          ? t(
              `cycle toutes les ${s.polling_interval_seconds}s`,
              `cycle every ${s.polling_interval_seconds}s`,
            )
          : "—",
      tone: !s?.polling_enabled ? "amber" : cycleNeverRan ? "red" : "green",
    },
    {
      name: t("API GLPI", "GLPI API"),
      state: !h?.glpi.configured
        ? t("Non configurée", "Not configured")
        : h.glpi.reachable
          ? t("Connecté", "Connected")
          : t("Injoignable", "Unreachable"),
      meta: isV2
        ? t("API V2 (high-level OAuth2)", "V2 API (high-level OAuth2)")
        : t("API legacy (apirest.php)", "Legacy API (apirest.php)"),
      tone: !h?.glpi.configured ? "muted" : h.glpi.reachable ? "green" : "red",
    },
    {
      name: t("Fournisseur IA", "AI provider"),
      // « Configuré » = une clé est en base, PAS qu'elle fonctionne. Tant que la sonde
      // n'a pas été lancée, la tuile le dit au lieu d'afficher du vert.
      state: !h?.llm.configured
        ? t("Clé absente", "No key")
        : llmProbed
          ? probeResult
            ? t("Joignable", "Reachable")
            : t("Injoignable", "Unreachable")
          : t("Configuré", "Configured"),
      meta: !h?.llm.configured
        ? t("aucune clé enregistrée", "no key stored")
        : llmProbed
          ? probeResult
            ? t("clé validée par un appel réel", "key validated by a real call")
            : t("la clé est refusée par le fournisseur", "the provider rejected the key")
          : t("clé enregistrée — validité NON vérifiée", "key stored — validity NOT verified"),
      tone: !h?.llm.configured ? "muted" : llmProbed ? (probeResult ? "green" : "red") : "amber",
      children: h?.llm.configured ? (
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={testLlm} disabled={probing}>
            {probing
              ? t("Test en cours…", "Testing…")
              : t("Tester la connexion", "Test connection")}
          </Button>
          <p className="mt-1 text-[10.5px] text-muted-foreground">
            {t(
              "appel réel au fournisseur (facturé) — lancé uniquement à la demande",
              "real call to the provider (billed) — only on demand",
            )}
          </p>
          {probeError && (
            <p className="mt-1 text-[11px] text-destructive">
              {t("Échec du test :", "Test failed:")} {probeError}
            </p>
          )}
        </div>
      ) : undefined,
    },
    {
      name: t("Base de données", "Database"),
      state: dbState,
      meta: dbMeta,
      tone: status.error ? "red" : dbRead ? "green" : "muted",
    },
    {
      name: t("Liste blanche", "Whitelist"),
      state:
        s?.categories_count != null && s.technicians_count != null
          ? `${s.categories_count} / ${s.technicians_count}`
          : "—",
      meta: t("catégories / techniciens", "categories / technicians"),
      tone: s?.whitelist_loaded ? "indigo" : "muted",
    },
    {
      name: t("Plafond de coût", "Cost ceiling"),
      state:
        s?.cost_eur_last_24h != null && s.cost_cap_eur_per_day != null
          ? `${s.cost_eur_last_24h} / ${s.cost_cap_eur_per_day} €`
          : "—",
      meta: t("période 24 h", "24h window"),
      tone: overCap ? "amber" : "green",
    },
  ];

  return (
    <div className="space-y-4">
      {/* status/health en échec : on l'affiche au lieu de « — » partout sans explication. */}
      {loadError && (
        <Banner kind="error">
          {t("API injoignable :", "API unreachable:")} {loadError}
        </Banner>
      )}
      <LastCycleCard
        cycleState={cycleState}
        intervalSeconds={s?.polling_interval_seconds ?? null}
        pollingEnabled={s?.polling_enabled === true}
        t={t}
        locale={locale}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {services.map((svc) => (
          <ServicePanel key={svc.name} {...svc} />
        ))}
      </div>
      <Card className="p-4">
        <div className="mb-1 text-[13px] font-medium">{t("Compteurs", "Counters")}</div>
        <div className="text-[11px] text-muted-foreground">
          {s?.llm_calls_total != null && s.cost_eur_last_24h != null
            ? t(
                `${s.llm_calls_total.toLocaleString("fr-FR")} appels LLM au total · ${s.cost_eur_last_24h} € sur les dernières 24 h`,
                `${s.llm_calls_total.toLocaleString("en-US")} total LLM calls · ${s.cost_eur_last_24h} € over the last 24h`,
              )
            : "—"}
        </div>
      </Card>
    </div>
  );
}
