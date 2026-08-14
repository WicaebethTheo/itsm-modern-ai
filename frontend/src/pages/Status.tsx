import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dot, type DotTone } from "@/components/ui/dot";
import { useResource } from "@/hooks/useResource";
import {
  Api,
  type LlmTestResult,
  type PollCycle,
  type PollCycleState,
  type PollRunResult,
  readPollCycle,
} from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type T = (fr: string, en: string) => string;

/** Rythme de l'horloge d'affichage : l'âge du dernier cycle doit VIEILLIR à l'écran. */
const CLOCK_MS = 15_000;
/** Rafraîchissement auto de /api/status SEULEMENT (lecture en base, aucun appel sortant). */
const STATUS_REFRESH_MS = 60_000;

/**
 * Sens porté par la pastille, en texte pour les lecteurs d'écran : une pastille de 6 px
 * sans libellé ne dit rien, et le libellé de la tuile ne porte pas toujours la sévérité
 * (« Configuré » en ambre, « 4 techniciens » en indigo…).
 */
function toneLabel(tone: DotTone, t: T): string {
  switch (tone) {
    case "green":
      return t("état : normal", "state: healthy");
    case "indigo":
      return t("état : renseigné", "state: populated");
    case "amber":
      return t("état : à surveiller", "state: needs attention");
    case "red":
      return t("état : en échec", "state: failing");
    default:
      return t("état : non mesuré", "state: not measured");
  }
}

function StateDot({ tone, pulse, t }: { tone: DotTone; pulse?: boolean; t: T }) {
  return (
    <span className="inline-flex items-center">
      <Dot tone={tone} pulse={pulse} />
      <span className="sr-only">{toneLabel(tone, t)}</span>
    </span>
  );
}

interface Tile {
  name: string;
  state: string;
  meta: string;
  tone: DotTone;
  /** Données pas encore reçues : on affiche un squelette au lieu d'AFFIRMER un état. */
  loading?: boolean;
  /** Le contenu de la tuile change en place (sonde IA) → il doit être annoncé. */
  live?: boolean;
  children?: ReactNode;
}

function ServicePanel({
  name,
  state,
  meta,
  tone,
  loading = false,
  live = false,
  t,
  children,
}: Tile & { t: T }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-ui font-medium">{name}</h2>
        {loading ? (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-muted" />
        ) : (
          <StateDot tone={tone} t={t} />
        )}
      </div>
      {/* Conteneur STABLE : la région live doit préexister au changement pour être annoncée. */}
      <div aria-live={live ? "polite" : undefined}>
        {loading ? (
          <>
            <span className="mt-2 block h-4 w-28 animate-pulse rounded bg-muted" />
            <span className="mt-2 block h-2.5 w-40 animate-pulse rounded bg-muted" />
            <span className="sr-only">{t("mesure en cours…", "measuring…")}</span>
          </>
        ) : (
          <>
            <div className="mt-2 text-metric font-semibold tracking-tight">{state}</div>
            <div className="mt-1 text-caption text-muted-foreground">{meta}</div>
          </>
        )}
      </div>
      {!loading && children}
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

/** Montant à 2 décimales, dans la locale de l'UI (« 1,83 € » / « €1.83 »). */
function formatEuro(value: number, t: T, locale: string): string {
  const n = value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return t(`${n} €`, `€${n}`);
}

/** Compteurs du cycle en une phrase : « 12 vus, 3 triés, 9 déjà traités, … ». */
function formatCounts(c: PollCycle, t: T): string {
  const n = (v: number | null) => (v == null ? "?" : String(v));
  // Accord : 0 et 1 au singulier (« 1 vu, 1 trié »), inconnu (`?`) au pluriel par défaut.
  const s = (v: number | null) => (v != null && v <= 1 ? "" : "s");
  return t(
    `${n(c.fetched)} vu${s(c.fetched)}, ${n(c.processed)} trié${s(c.processed)}, ${n(c.skipped_done)} déjà traité${s(c.skipped_done)}, ${n(c.skipped_scope)} hors périmètre, ${n(c.errors)} erreur${s(c.errors)}`,
    `${n(c.fetched)} seen, ${n(c.processed)} triaged, ${n(c.skipped_done)} already done, ${n(c.skipped_scope)} out of scope, ${n(c.errors)} error${s(c.errors)}`,
  );
}

/**
 * Santé d'un cycle, à partir de compteurs qui ne disent PAS ce qu'on leur faisait dire.
 *
 * `errors` est incrémenté PAR TICKET par le poller (`scheduler/poller.py`) : une erreur
 * sur cent tickets n'est pas un cycle en panne. Deux états, jamais confondus :
 * - `failed` : des erreurs ET aucun ticket trié → le cycle n'a rien produit ;
 * - `partial` : des erreurs mais des tickets triés → un avertissement chiffré, pas une
 *   panne (« 1 ticket en échec sur 100 » et non « le moteur ne trie plus »).
 */
export interface CycleHealth {
  errors: number;
  processed: number;
  /** Dénominateur affichable : tickets lus, à défaut triés + en échec. */
  total: number;
  failed: boolean;
  partial: boolean;
}

export function readCycleHealth(cycle: PollCycle | null): CycleHealth {
  const errors = cycle?.errors ?? 0;
  const processed = cycle?.processed ?? 0;
  return {
    errors,
    processed,
    total: cycle?.fetched ?? processed + errors,
    failed: errors > 0 && processed === 0,
    partial: errors > 0 && processed > 0,
  };
}

/** « 1 ticket en échec sur 100 » — le compte réel, mesuré, sans extrapolation. */
export function partialLabel(h: CycleHealth, t: T): string {
  const s = h.errors > 1 ? "s" : "";
  return t(
    `${h.errors} ticket${s} en échec sur ${h.total}`,
    `${h.errors} ticket${s} failed out of ${h.total}`,
  );
}

/**
 * Piste de diagnostic dérivée des compteurs — les causes réelles de « aucun ticket n'est
 * trié » sont toutes lisibles ici, alors qu'aucune ne l'était dans les tuiles.
 *
 * Les erreurs, elles, ne sont plus traitées ici : elles ont leur propre bandeau (échec du
 * cycle) ou leur propre avertissement chiffré (échecs partiels), qui disent COMBIEN de
 * tickets sont concernés au lieu de conclure à l'arrêt du moteur.
 */
export function cycleHint(c: PollCycle, t: T): string | null {
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

/**
 * État de la tuile « Fournisseur IA » d'après le dernier test RÉEL.
 *
 * Tant qu'aucun test n'a tourné, la tuile ne dit que ce qui est vrai : une clé est en base.
 * Après le test, elle distingue les deux pannes que l'ancienne sonde (`GET /models`)
 * confondait — le fournisseur muet, et le fournisseur bavard dont la sortie est inutilisable.
 * La seconde est la plus traître : rien n'a l'air cassé et tous les tickets partent « à trier ».
 */
export function llmTileState(
  configured: boolean,
  test: LlmTestResult | null,
  t: T,
): { state: string; meta: string; tone: DotTone } {
  if (!configured) {
    return {
      state: t("Non configuré", "Not configured"),
      meta: t("aucune clé enregistrée", "no key stored"),
      tone: "muted",
    };
  }
  if (test === null) {
    return {
      state: t("Configuré", "Configured"),
      meta: t("clé enregistrée — validité NON vérifiée", "key stored — validity NOT verified"),
      tone: "amber",
    };
  }
  switch (test.stage) {
    case "ok":
      return {
        state: t("Opérationnel", "Operational"),
        meta: t(
          "le modèle a rendu une Décision exploitable",
          "the model returned a usable Decision",
        ),
        tone: "green",
      };
    case "invalid_output":
      return {
        state: t("Sortie inexploitable", "Unusable output"),
        meta: t(
          "le modèle répond, mais pas une Décision valide : tout partirait « à trier »",
          "the model answers, but not a valid Decision: everything would fall back to « to triage »",
        ),
        tone: "amber",
      };
    case "cost_cap_reached":
      return {
        state: t("Non testé", "Not tested"),
        meta: t(
          "plafond de coût atteint : aucun appel facturable n'est passé",
          "cost ceiling reached: no billable call was made",
        ),
        tone: "amber",
      };
    case "not_configured":
      return {
        state: t("Non configuré", "Not configured"),
        meta: t("aucune clé enregistrée", "no key stored"),
        tone: "muted",
      };
    default:
      return {
        state: t("Injoignable", "Unreachable"),
        meta: t("aucun appel n'a abouti", "no call went through"),
        tone: "red",
      };
  }
}

/**
 * Ce qu'un cycle déclenché à la main vient de produire — ou pourquoi il n'a rien produit.
 * Les trois refus sont des états de configuration, pas des pannes : ils se lisent en
 * avertissement, avec le geste qui les lève.
 */
export function pollRunMessage(
  r: PollRunResult,
  t: T,
): { kind: "success" | "warning" | "info"; text: string } {
  switch (r.outcome) {
    case "ran":
      return {
        kind: "success",
        // Durée en millisecondes : pas de séparateur décimal, donc rien à localiser — et
        // c'est la grandeur utile (un cycle qui traîne se voit à 40 000 ms comme à 40 s).
        text: t(
          `Cycle terminé en ${r.duration_ms} ms — ${formatCounts(r.cycle, t)}.`,
          `Cycle finished in ${r.duration_ms} ms — ${formatCounts(r.cycle, t)}.`,
        ),
      };
    case "polling_disabled":
      return {
        kind: "warning",
        text: t(
          "Le polling est en pause : aucun cycle n'a été lancé. La pause est l'arrêt d'urgence du moteur — elle n'est pas contournée par ce bouton.",
          "Polling is paused: no cycle was started. The pause is the engine's emergency stop — this button does not bypass it.",
        ),
      };
    case "glpi_not_configured":
      return {
        kind: "warning",
        text: t(
          "Aucune connexion GLPI enregistrée : il n'y a rien à lire.",
          "No GLPI connection stored: there is nothing to read.",
        ),
      };
    default:
      return {
        kind: "info",
        text: t(
          "Un cycle était déjà en cours : rien n'a été relancé par-dessus.",
          "A cycle was already running: nothing was started on top of it.",
        ),
      };
  }
}

type VerdictKind = "unknown" | "ok" | "warn" | "bad";

interface Verdict {
  kind: VerdictKind;
  tone: DotTone;
  title: string;
  detail: string;
}

const verdictStyle: Record<VerdictKind, string> = {
  unknown: "border-border bg-muted/50",
  ok: "border-success/30 bg-success/10",
  warn: "border-warning/40 bg-warning/10",
  bad: "border-destructive/40 bg-destructive/10",
};

/**
 * Pourquoi la page ne sait rien — deux causes DISTINCTES : l'API n'a pas (encore) répondu,
 * ou elle a répondu sans le bloc de cycle. Les confondre faisait dire au verdict « l'API
 * n'a pas répondu » à propos d'une réponse qu'il venait de lire.
 */
export type UnknownReason = "api" | "cycle";

/**
 * Verdict unique — la seule question de l'exploitant est binaire : « est-ce que ça trie ? ».
 * Les 7 tuiles portaient déjà tous les signaux, mais à poids égal : à lui de recomposer.
 * Priorité STRICTE des causes ; ne jamais réutiliser ici les libellés « En marche » /
 * « En pause » des tuiles (ils doivent rester identifiables un par un).
 *
 * Ordre : ce qu'on n'a PAS mesuré, puis la mise en service (une instance neuve n'est pas
 * en panne), puis les pannes, puis les choix de configuration, puis les avertissements.
 * Le cas nominal est le DERNIER, et il exige une fraîcheur réellement mesurée.
 */
export function computeVerdict(args: {
  unknown: boolean;
  unknownReason: UnknownReason;
  health: CycleHealth;
  neverRan: boolean;
  pollingEnabled: boolean;
  stale: boolean;
  /** Le dernier cycle est horodaté : sans ça, « dans son intervalle » n'est pas mesurable. */
  ageKnown: boolean;
  glpiConfigured: boolean;
  glpiReachable: boolean;
  llmConfigured: boolean;
  t: T;
}): Verdict {
  const { t } = args;
  if (args.unknown) {
    return {
      kind: "unknown",
      tone: "muted",
      title: t("Statut du moteur inconnu", "Engine status unknown"),
      detail:
        args.unknownReason === "cycle"
          ? t(
              "Le moteur a répondu, mais sans l'état de son dernier cycle : cette page ne peut ni confirmer ni infirmer qu'il trie.",
              "The engine answered, but without its last cycle state: this page can neither confirm nor deny that it triages.",
            )
          : t(
              "Rien n'a encore été mesuré : tant que l'API n'a pas répondu, cette page n'affirme ni marche ni arrêt.",
              "Nothing has been measured yet: until the API answers, this page claims neither running nor stopped.",
            ),
    };
  }
  // MISE EN SERVICE avant tout diagnostic de panne. Sans connexion GLPI, le cycle sort
  // avant même de persister ses compteurs : « le moteur n'a jamais trié » nommait le
  // symptôme en taisant la cause, qu'on a pourtant sous la main.
  if (!args.glpiConfigured) {
    return {
      kind: "warn",
      tone: "amber",
      title: t("GLPI n'est pas encore configuré", "GLPI is not configured yet"),
      detail: t(
        "Aucune connexion GLPI n'est enregistrée : le moteur n'a aucun ticket à lire, la boucle tourne à vide. Renseignez la connexion pour mettre le triage en service.",
        "No GLPI connection is stored: the engine has no ticket to read, the loop spins empty. Set the connection to put triage into service.",
      ),
    };
  }
  if (!args.glpiReachable) {
    return {
      kind: "bad",
      tone: "red",
      title: t(
        "GLPI est injoignable — rien ne peut être trié",
        "GLPI is unreachable — nothing can be triaged",
      ),
      detail: t(
        "La connexion GLPI est enregistrée mais elle a échoué : sans lecture des tickets, la boucle tourne à vide.",
        "The GLPI connection is stored but it failed: with no ticket to read, the loop spins empty.",
      ),
    };
  }
  // Sans fournisseur IA, la boucle tourne, lit ses tickets et incrémente ses compteurs :
  // des cycles verts, zéro erreur… et zéro triage. Le verdict le dit avant de conclure.
  if (!args.llmConfigured) {
    return {
      kind: "warn",
      tone: "amber",
      title: t("Aucun fournisseur IA n'est configuré", "No AI provider is configured"),
      detail: t(
        "Aucune clé n'est enregistrée : les cycles peuvent se dérouler sans erreur, mais rien n'est analysé et tout part « à trier ».",
        "No key is stored: cycles may complete without error, yet nothing is analyzed and everything falls back to « to triage ».",
      ),
    };
  }
  if (args.health.failed) {
    return {
      kind: "bad",
      tone: "red",
      title: t("Le moteur ne trie plus", "The engine has stopped triaging"),
      detail: t(
        "Le dernier cycle a remonté des erreurs sans trier un seul ticket. Les tickets partent « à trier » tant que la cause n'est pas levée — le détail est dans la carte du dernier cycle.",
        "The last cycle reported errors without triaging a single ticket. Tickets fall back to « to triage » until the cause is fixed — details in the last cycle card below.",
      ),
    };
  }
  if (args.neverRan) {
    // « Jamais exécuté » + polling coupé = un choix de configuration, pas une panne : la
    // carte du dernier cycle le disait déjà correctement, le verdict la contredisait.
    if (!args.pollingEnabled) {
      return {
        kind: "warn",
        tone: "amber",
        title: t("Triage en pause", "Triage paused"),
        detail: t(
          "La boucle de polling est coupée et aucun cycle n'a jamais tourné : c'est attendu tant qu'elle n'est pas réactivée. C'est un choix de configuration, pas une panne.",
          "The polling loop is switched off and no cycle has ever run: expected until it is re-enabled. This is a configuration choice, not a failure.",
        ),
      };
    }
    return {
      kind: "bad",
      tone: "red",
      title: t("Le moteur n'a jamais trié", "The engine has never triaged"),
      detail: t(
        "Aucun cycle n'a été mené à son terme depuis le démarrage : aucun ticket n'a pu être examiné.",
        "No cycle has ever completed since startup: not a single ticket could be examined.",
      ),
    };
  }
  if (!args.pollingEnabled) {
    return {
      kind: "warn",
      tone: "amber",
      title: t("Triage en pause", "Triage paused"),
      detail: t(
        "La boucle de polling est coupée : plus aucun ticket n'est lu. C'est un choix de configuration, pas une panne.",
        "The polling loop is switched off: no ticket is read anymore. This is a configuration choice, not a failure.",
      ),
    };
  }
  if (args.health.partial) {
    return {
      kind: "warn",
      tone: "amber",
      title: t(
        "Des tickets sont partis « à trier » sur erreur",
        "Some tickets fell back to « to triage » on error",
      ),
      detail: t(
        `Le dernier cycle a bien trié, mais ${partialLabel(args.health, t)} : ces tickets-là partent « à trier ». Le moteur, lui, continue de tourner.`,
        `The last cycle did triage, but ${partialLabel(args.health, t)}: those tickets fall back to « to triage ». The engine itself keeps running.`,
      ),
    };
  }
  if (args.stale) {
    return {
      kind: "warn",
      tone: "amber",
      title: t("Le moteur est peut-être arrêté", "The engine may be stopped"),
      detail: t(
        "Le dernier cycle remonte à bien plus longtemps que l'intervalle configuré : le processus a pu mourir sans le dire.",
        "The last cycle is far older than the configured interval: the process may have died silently.",
      ),
    };
  }
  // Sans horodatage, « cycle trop ancien » est neutralisé en silence : affirmer ici
  // « dans son intervalle » serait affirmer une fraîcheur qu'on n'a PAS pu mesurer.
  if (!args.ageKnown) {
    return {
      kind: "unknown",
      tone: "muted",
      title: t("Fraîcheur du dernier cycle inconnue", "Last cycle freshness unknown"),
      detail: t(
        "Le dernier cycle n'est pas horodaté : impossible de vérifier d'ici qu'il tourne encore dans son intervalle. Ses compteurs restent lisibles ci-dessous.",
        "The last cycle carries no timestamp: there is no way to check from here that it still runs within its interval. Its counters remain readable below.",
      ),
    };
  }
  return {
    kind: "ok",
    tone: "green",
    title: t("Le moteur trie les tickets", "The engine is triaging tickets"),
    detail: t(
      "Le dernier cycle s'est terminé sans erreur, dans son intervalle, et GLPI répond.",
      "The last cycle completed without error, within its interval, and GLPI answers.",
    ),
  };
}

/** Message d'un cycle manuel. La pause renvoie vers l'écran qui la lève, pas ailleurs. */
function PollRunBanner({ run, t }: { run: PollRunResult; t: T }) {
  const m = pollRunMessage(run, t);
  return (
    <Banner kind={m.kind} role="status">
      {m.text}
      {run.outcome === "polling_disabled" && (
        <>
          {" "}
          <Link to="/engine/ingestion" className="underline underline-offset-2">
            {t("Réactiver l'ingestion", "Re-enable ingestion")}
          </Link>
        </>
      )}
      {run.outcome === "glpi_not_configured" && (
        <>
          {" "}
          <Link to="/glpi" className="underline underline-offset-2">
            {t("Configurer GLPI", "Configure GLPI")}
          </Link>
        </>
      )}
    </Banner>
  );
}

function VerdictCard({ verdict, t }: { verdict: Verdict; t: T }) {
  return (
    <Card className={cn("p-4", verdictStyle[verdict.kind])}>
      <div className="flex items-center gap-2">
        <StateDot tone={verdict.tone} pulse={verdict.kind === "ok"} t={t} />
        <h2 className="text-metric font-semibold tracking-tight">{verdict.title}</h2>
      </div>
      <p className="mt-1 text-body">{verdict.detail}</p>
    </Card>
  );
}

/** Carte « dernier cycle » : l'information n°1 pour savoir si le moteur travaille. */
function LastCycleCard({
  cycleState,
  intervalSeconds,
  pollingEnabled,
  runAt,
  ageSeconds,
  stale,
  health,
  t,
  locale,
}: {
  cycleState: PollCycleState;
  intervalSeconds: number | null;
  pollingEnabled: boolean;
  runAt: Date | null;
  ageSeconds: number | null;
  stale: boolean;
  health: CycleHealth;
  t: T;
  locale: string;
}) {
  const title = t("Dernier cycle de polling", "Last polling cycle");

  if (cycleState.kind === "unavailable") {
    return (
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-ui font-medium">{title}</h2>
          <StateDot tone="muted" t={t} />
        </div>
        <div className="mt-2 text-metric font-semibold tracking-tight">
          {t("Non mesuré", "Not measured")}
        </div>
        <div className="mt-1 text-body text-muted-foreground">
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
          <h2 className="text-ui font-medium">{title}</h2>
          <StateDot tone={pollingEnabled ? "red" : "amber"} t={t} />
        </div>
        <div className="mt-2 text-metric font-semibold tracking-tight">
          {t("Aucun cycle exécuté", "No cycle has run")}
        </div>
        <div className="mt-1 text-body text-muted-foreground">
          {pollingEnabled
            ? t(
                "La boucle de polling est annoncée « En marche » mais n'a jamais bouclé une seule fois : aucun ticket ne peut être trié.",
                'The polling loop reports "Running" but has never completed a single loop: no ticket can be triaged.',
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
  const tone: DotTone = health.failed ? "red" : health.partial || stale ? "amber" : "green";
  const hint = cycleHint(cycle, t);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-ui font-medium">{title}</h2>
        <StateDot tone={tone} pulse={!health.failed && !health.partial && !stale} t={t} />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-metric font-semibold tracking-tight">
          {ageSeconds != null ? formatAge(ageSeconds, t) : t("date inconnue", "unknown date")}
        </span>
        {stale && (
          // Le sens passe par un fond ambre, pas par du texte ambre de 11 px : en thème
          // clair, `text-warning` sur fond de carte tombe sous le seuil de contraste.
          <span className="rounded bg-warning/20 px-1.5 py-0.5 text-caption font-medium text-foreground">
            {t("cycle trop ancien", "cycle overdue")}
          </span>
        )}
      </div>
      <div className="mt-1 text-body">{formatCounts(cycle, t)}</div>
      <div className="mt-1 text-caption text-muted-foreground">
        {runAt
          ? runAt.toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" })
          : t("horodatage absent", "no timestamp")}
        {intervalSeconds != null &&
          t(` · intervalle ${intervalSeconds} s`, ` · every ${intervalSeconds} s`)}
      </div>
      {stale && !health.failed && (
        <div className="mt-3">
          <Banner kind="warning">
            {t(
              "La boucle de polling n'a pas bouclé depuis bien plus longtemps que son intervalle : vérifiez qu'elle tourne (logs du conteneur) et que GLPI répond.",
              "The polling loop has not looped for far longer than its interval: check that it is running (container logs) and that GLPI answers.",
            )}
          </Banner>
        </div>
      )}
      {health.failed && (
        <div className="mt-3">
          <Banner kind="error">
            {cycle.error_message ??
              t("Erreur non détaillée par le moteur.", "No error detail reported by the engine.")}
          </Banner>
        </div>
      )}
      {/* Échecs PARTIELS : un avertissement chiffré, jamais un constat de panne — le
          compteur `errors` du moteur est incrémenté ticket par ticket. */}
      {health.partial && (
        <div className="mt-3">
          <Banner kind="warning">
            {t(
              `${partialLabel(health, t)} : ces tickets-là sont partis « à trier », les autres ont été traités normalement.`,
              `${partialLabel(health, t)}: those tickets fell back to « to triage », the others were handled normally.`,
            )}
            {cycle.error_message ? ` — ${cycle.error_message}` : ""}
          </Banner>
        </div>
      )}
      {hint && !health.failed && (
        <div className="mt-2 text-caption text-muted-foreground">{hint}</div>
      )}
    </Card>
  );
}

export function Status() {
  const t = useT();
  const locale = useLocale();
  const status = useResource(useCallback(() => Api.status(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const s = status.data;
  const h = health.data;
  // Version d'API réellement configurée (comme Layout) — le méta ne doit pas être figé.
  const isV2 = cfg.data?.glpi_api_version === "v2";
  const loadError = status.error ?? health.error;

  // Horloge d'AFFICHAGE : sans elle, `Date.now()` était figé au premier rendu — un onglet
  // laissé ouvert affichait « il y a 42 s » pour l'éternité et « cycle trop ancien » ne se
  // déclenchait JAMAIS.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  // Rafraîchissement automatique de /api/status UNIQUEMENT : cette route ne lit que la
  // base. /health, lui, INTERROGE GLPI — l'auto-rafraîchir installerait du trafic sortant
  // permanent vers le GLPI du client. Il reste donc sur action explicite.
  const reloadStatus = status.reload;
  useEffect(() => {
    const id = setInterval(() => reloadStatus(), STATUS_REFRESH_MS);
    return () => clearInterval(id);
  }, [reloadStatus]);

  const reloadHealth = health.reload;
  const reloadCfg = cfg.reload;
  const reloadAll = useCallback(() => {
    reloadStatus();
    reloadHealth();
    reloadCfg();
  }, [reloadStatus, reloadHealth, reloadCfg]);

  // Test LLM : action EXPLICITE (appel sortant facturé, réservé aux sessions admin).
  // Ce n'est plus `/health?probe=true` : cette sonde-là ne faisait qu'un `GET /models`, et
  // la tuile en concluait « clé validée par un appel réel » — une affirmation que rien ne
  // soutenait. `POST /api/llm/test` soumet un vrai ticket et valide la Décision rendue.
  const [probing, setProbing] = useState(false);
  const [llmTest, setLlmTest] = useState<LlmTestResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const testLlm = useCallback(async () => {
    setProbing(true);
    setProbeError(null);
    try {
      setLlmTest(await Api.testLlm());
    } catch (e) {
      setLlmTest(null);
      setProbeError((e as Error).message);
    } finally {
      setProbing(false);
    }
  }, []);

  // Cycle de polling déclenché à la main : le moteur poll à intervalle fixe, et entre deux
  // battements un exploitant qui vient de configurer GLPI ou le fournisseur n'a rien à
  // regarder. Le cycle lancé ici est CELUI du scheduler, gardes comprises.
  const [pollingNow, setPollingNow] = useState(false);
  const [pollRun, setPollRun] = useState<PollRunResult | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const runPollNow = useCallback(async () => {
    setPollingNow(true);
    setPollError(null);
    setPollRun(null);
    try {
      const res = await Api.runPoll();
      setPollRun(res);
      // Les compteurs de la page viennent de /api/status : sans ce rechargement, la carte
      // « dernier cycle » afficherait encore le cycle PRÉCÉDENT sous le message de succès.
      reloadStatus();
    } catch (e) {
      setPollError((e as Error).message);
    } finally {
      setPollingNow(false);
    }
  }, [reloadStatus]);

  // Trois états distincts par source, et surtout : « pas encore de donnée » n'est PAS
  // « service à l'arrêt ». Tant que `data` est nul sans erreur, on ne dit rien.
  const statusMute = status.error != null;
  const statusLoading = s == null && !statusMute;
  const healthMute = health.error != null;
  const healthLoading = h == null && !healthMute;

  // Champs enrichis renvoyés seulement avec une session admin (la page est derrière
  // RequireAuth, mais on reste défensif : le type les déclare optionnels).
  const spent = s?.cost_eur_last_24h;
  const cap = s?.cost_cap_eur_per_day;
  // Un plafond à 0 signifie « AUCUN plafond » (services/cost_cap.py) — surtout pas
  // « budget nul » : l'afficher « 1.83 / 0 € » en vert disait exactement l'inverse.
  const noCap = cap === 0;
  const overCap = spent != null && cap != null && cap > 0 && spent >= cap;

  const cycleState = readPollCycle(s);
  const cycleNeverRan = cycleState.kind === "never";
  const cycle = cycleState.kind === "ran" ? cycleState.cycle : null;
  const runAt = cycle?.run_at ? parseEngineDate(cycle.run_at) : null;
  // Âge relu à chaque battement d'horloge (`now`), plus au seul premier rendu.
  const ageSeconds = runAt ? Math.max(0, (now - runAt.getTime()) / 1000) : null;
  // « Trop ancien » = plus de 3 cycles manqués (plancher 5 min, pour ne pas crier au loup
  // sur un intervalle très court juste après un redémarrage).
  const staleAfter = Math.max((s?.polling_interval_seconds ?? 60) * 3, 300);
  const stale = ageSeconds != null && ageSeconds > staleAfter;
  // Un cycle en PANNE (rien de trié) ≠ des tickets en échec parmi d'autres traités.
  const cycleHealth = readCycleHealth(cycle);

  // « Pas encore répondu / muette » et « a répondu sans le bloc de cycle » sont deux
  // ignorances différentes : le verdict doit expliquer la bonne.
  const apiSilent = statusLoading || healthLoading || statusMute || healthMute;
  const verdict = computeVerdict({
    unknown: apiSilent || cycleState.kind === "unavailable",
    unknownReason: apiSilent ? "api" : "cycle",
    health: cycleHealth,
    neverRan: cycleNeverRan,
    pollingEnabled: s?.polling_enabled === true,
    stale,
    ageKnown: ageSeconds != null,
    glpiConfigured: h?.glpi.configured === true,
    glpiReachable: h?.glpi.reachable === true,
    llmConfigured: h?.llm.configured === true,
    t,
  });

  // Tuile « Base de données » : aucune sonde n'existe côté API. Le seul fait mesurable
  // est que /api/status a renvoyé ses compteurs — ils viennent de requêtes SQL réelles
  // (comptage des appels LLM, coût 24 h). Hors de ce cas, on n'affirme RIEN.
  const dbRead = s?.llm_calls_total != null;

  /** Tuile d'une source muette : « Inconnu », ton neutre, aucune affirmation. */
  const unknownTile = (name: string): Tile => ({
    name,
    state: t("Inconnu", "Unknown"),
    meta: t("l'API n'a pas répondu", "the API did not answer"),
    tone: "muted",
  });

  const glpiApiLabel = isV2
    ? t("API V2 (high-level OAuth2)", "V2 API (high-level OAuth2)")
    : t("API legacy (apirest.php)", "Legacy API (apirest.php)");

  const services: Tile[] = [
    statusMute
      ? unknownTile(t("Boucle de polling", "Polling loop"))
      : {
          name: t("Boucle de polling", "Polling loop"),
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
          tone: !s?.polling_enabled ? "amber" : cycleNeverRan ? "red" : stale ? "amber" : "green",
          loading: statusLoading,
        },
    healthMute
      ? unknownTile(t("API GLPI", "GLPI API"))
      : {
          name: t("API GLPI", "GLPI API"),
          state: !h?.glpi.configured
            ? t("Non configuré", "Not configured")
            : h.glpi.reachable
              ? t("Connecté", "Connected")
              : t("Injoignable", "Unreachable"),
          // `glpi.version` est renvoyé par le backend : diagnostic gratuit, il n'était
          // affiché nulle part.
          // (`glpiApiLabel` est déjà traduit : le numéro de version, lui, ne l'est pas.)
          meta: h?.glpi.version ? `GLPI ${h.glpi.version} · ${glpiApiLabel}` : glpiApiLabel,
          tone: !h?.glpi.configured ? "muted" : h.glpi.reachable ? "green" : "red",
          loading: healthLoading,
        },
    healthMute
      ? unknownTile(t("Fournisseur IA", "AI provider"))
      : {
          name: t("Fournisseur IA", "AI provider"),
          // « Configuré » = une clé est en base, PAS qu'elle fonctionne. Tant que le test
          // n'a pas tourné, la tuile le dit au lieu d'afficher du vert.
          ...llmTileState(h?.llm.configured === true, llmTest, t),
          loading: healthLoading,
          live: true,
          children: h?.llm.configured ? (
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={testLlm} disabled={probing}>
                {probing
                  ? t("Test en cours…", "Testing…")
                  : t("Tester la connexion", "Test connection")}
              </Button>
              <p className="mt-1 text-caption text-muted-foreground">
                {t(
                  "ticket fictif soumis au modèle — appel réel, facturé et journalisé",
                  "fake ticket submitted to the model — real call, billed and journaled",
                )}
              </p>
              {llmTest?.latency_ms != null && (
                <p className="mt-1 text-caption text-muted-foreground">
                  {llmTest.model ? `${llmTest.model} · ` : ""}
                  {llmTest.latency_ms} ms
                </p>
              )}
              {llmTest?.error && (
                <p className="mt-1 break-words text-caption text-muted-foreground">
                  {llmTest.error}
                </p>
              )}
              {probeError && (
                <div className="mt-2">
                  <Banner kind="error" role="alert">
                    {t("Échec du test :", "Test failed:")} {probeError}
                  </Banner>
                </div>
              )}
            </div>
          ) : undefined,
        },
    statusMute
      ? unknownTile(t("Base de données", "Database"))
      : {
          name: t("Base de données", "Database"),
          state: dbRead ? t("Lecture OK", "Read OK") : t("Non mesurée", "Not measured"),
          meta: dbRead
            ? t(
                "compteurs relus à l'ouverture de la page",
                "counters re-read when this page loaded",
              )
            : t("aucune sonde exposée par l'API", "no probe exposed by the API"),
          tone: dbRead ? "green" : "muted",
          loading: statusLoading,
        },
    statusMute
      ? unknownTile(t("Liste blanche", "Whitelist"))
      : {
          name: t("Liste blanche", "Whitelist"),
          // « 7 / 4 » en 18 px se lisait « 7 sur 4 ». Un compte par ligne, et rien du tout
          // tant que la liste blanche n'est pas chargée.
          state: !s?.whitelist_loaded
            ? t("Non chargée", "Not loaded")
            : s.categories_count != null
              ? t(
                  `${s.categories_count} catégorie${s.categories_count > 1 ? "s" : ""}`,
                  `${s.categories_count} categor${s.categories_count > 1 ? "ies" : "y"}`,
                )
              : "—",
          meta: !s?.whitelist_loaded
            ? t(
                "aucun périmètre en cache : synchronisez GLPI puis sélectionnez le périmètre",
                "no scope cached: sync GLPI then select the scope",
              )
            : s.technicians_count != null
              ? t(
                  `${s.technicians_count} technicien${s.technicians_count > 1 ? "s" : ""} dans le périmètre`,
                  `${s.technicians_count} technician${s.technicians_count > 1 ? "s" : ""} in scope`,
                )
              : "—",
          tone: s?.whitelist_loaded ? "indigo" : "muted",
          loading: statusLoading,
        },
    statusMute
      ? unknownTile(t("Plafond de coût", "Cost ceiling"))
      : {
          name: t("Plafond de coût", "Cost ceiling"),
          state:
            spent == null
              ? "—"
              : noCap || cap == null
                ? formatEuro(spent, t, locale)
                : `${formatEuro(spent, t, locale)} / ${formatEuro(cap, t, locale)}`,
          meta:
            spent == null
              ? t("aucun montant remonté", "no amount reported")
              : noCap
                ? t(
                    "dépense des dernières 24 h · aucun plafond : les appels ne sont jamais coupés",
                    "spend over the last 24h · no cap: calls are never cut off",
                  )
                : cap == null
                  ? t("dépense des dernières 24 h", "spend over the last 24h")
                  : overCap
                    ? t(
                        "plafond atteint : les appels LLM facturables sont coupés",
                        "cap reached: billable LLM calls are cut off",
                      )
                    : t(
                        "dépense des dernières 24 h · plafond journalier",
                        "spend over the last 24h · daily cap",
                      ),
          // Dépassement = ROUGE : le moteur arrête les appels facturables et renvoie tout
          // « à trier ». Ce n'est pas un avertissement, c'est un arrêt du triage.
          tone: spent == null ? "muted" : overCap ? "red" : noCap ? "amber" : "green",
          loading: statusLoading,
          children: overCap ? (
            <div className="mt-3">
              <Banner kind="error">
                {t(
                  "Plafond journalier atteint : les nouveaux tickets partent « à trier » jusqu'à la reprise (fenêtre glissante de 24 h ou plafond relevé).",
                  "Daily cap reached: new tickets fall back to « to triage » until it resumes (24h sliding window or a raised cap).",
                )}
              </Banner>
            </div>
          ) : undefined,
        },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-title font-semibold tracking-tight">
            {t("Ce que fait l'instance en ce moment", "What this instance is doing right now")}
          </h2>
          <p className="mt-1 max-w-2xl text-body text-muted-foreground">
            {t(
              "Cette page ne rend compte que de ce qui est MESURÉ : le dernier cycle réellement exécuté et l'état des services dont il dépend. Une case cochée dans la configuration n'y vaut jamais preuve de fonctionnement.",
              "This page reports only what is MEASURED: the last cycle actually run and the state of the services it depends on. A checkbox in the configuration is never taken as proof that something works.",
            )}
          </p>
        </div>
        <div className="max-w-[17rem] text-right">
          <div className="flex flex-wrap justify-end gap-2">
            {/* Le cycle déclenché ici est CELUI du scheduler : mêmes gardes, même pipeline.
                Il n'y a donc aucun chemin d'écriture GLPI supplémentaire à surveiller. */}
            <Button size="sm" onClick={runPollNow} disabled={pollingNow}>
              {pollingNow
                ? t("Cycle en cours…", "Cycle running…")
                : t("Lancer un cycle", "Run a cycle")}
            </Button>
            <Button variant="outline" size="sm" onClick={reloadAll}>
              {t("Tout réactualiser", "Refresh everything")}
            </Button>
          </div>
          <p className="mt-1 text-caption text-muted-foreground">
            {t(
              "le dernier cycle est actualisé automatiquement chaque minute ; GLPI n'est interrogé qu'à la demande",
              "the last cycle refreshes automatically every minute; GLPI is only queried on demand",
            )}
          </p>
        </div>
      </div>

      {/* Issue du cycle manuel. Le conteneur préexiste pour que le message soit ANNONCÉ
          (une région live créée en même temps que son contenu ne l'est pas). */}
      <div aria-live="polite" className="empty:hidden">
        {pollError && (
          <Banner kind="error" role="alert">
            {t("Cycle impossible :", "Cycle failed:")} {pollError}
          </Banner>
        )}
        {pollRun && <PollRunBanner run={pollRun} t={t} />}
      </div>

      {/* status/health en échec : on l'affiche au lieu de « — » partout sans explication. */}
      {loadError && (
        <Banner kind="error">
          {t("API injoignable :", "API unreachable:")} {loadError}
        </Banner>
      )}

      <VerdictCard verdict={verdict} t={t} />

      <LastCycleCard
        cycleState={cycleState}
        intervalSeconds={s?.polling_interval_seconds ?? null}
        pollingEnabled={s?.polling_enabled === true}
        runAt={runAt}
        ageSeconds={ageSeconds}
        stale={stale}
        health={cycleHealth}
        t={t}
        locale={locale}
      />

      <section
        aria-label={t("État détaillé des services", "Detailed service status")}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {services.map((svc) => (
          <ServicePanel key={svc.name} {...svc} t={t} />
        ))}
      </section>

      <Card className="p-4">
        <h2 className="mb-1 text-ui font-medium">{t("Compteurs", "Counters")}</h2>
        <div className="text-caption text-muted-foreground">
          {s?.llm_calls_total != null && s.cost_eur_last_24h != null
            ? t(
                `${s.llm_calls_total.toLocaleString(locale)} appels LLM au total · ${formatEuro(s.cost_eur_last_24h, t, locale)} sur les dernières 24 h`,
                `${s.llm_calls_total.toLocaleString(locale)} total LLM calls · ${formatEuro(s.cost_eur_last_24h, t, locale)} over the last 24h`,
              )
            : "—"}
        </div>
      </Card>
    </div>
  );
}
