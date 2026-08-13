import { ListChecks, RefreshCw, ScrollText, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { Link } from "react-router-dom";
import { Banner } from "@/components/Banner";
import { ProgressBar, Sparkline, StackedBars } from "@/components/Charts";
import { EmptyState } from "@/components/EmptyState";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { KpiCard } from "@/components/ui/kpi";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag, type TagTone } from "@/components/ui/tag";
import { useConfigDraft } from "@/hooks/useConfigDraft";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate, type ConfigView } from "@/lib/api";
import { tr, useLocale, useT } from "@/lib/i18n";
import { reasonLabel, reasonTone } from "@/lib/labels";
import { cn } from "@/lib/utils";

/** Décisions affichées dans l'aperçu du journal (la page complète est dans Journal). */
const PREVIEW_ROWS = 8;
/** Anomalies listées au maximum : une instance avec 300 SLA dépassés ne déroule pas 300 lignes. */
const ANOMALY_LIMIT = 8;

/** Squelette de chargement — même idiome que GlpiConnection (`animate-pulse bg-muted`). */
function Skeleton({ className }: { className?: string }) {
  return <span className={cn("block animate-pulse rounded bg-muted", className)} aria-hidden />;
}

/** Couleur de la barre d'un motif : reprend le ton du Tag pour que les deux s'accordent. */
const REASON_BAR: Record<TagTone, string> = {
  green: "bg-success",
  red: "bg-destructive",
  amber: "bg-warning",
  indigo: "bg-primary",
  purple: "bg-primary",
  muted: "bg-muted-foreground",
};

interface VueDraft {
  fenetre: string;
  anomalie: string;
}

function toVueDraft(c: ConfigView | null): VueDraft {
  return {
    fenetre: c?.dashboard_window_days ?? "",
    anomalie: c?.anomaly_new_age_hours ?? "",
  };
}

function toVuePayload(d: VueDraft): ConfigUpdate {
  const p: ConfigUpdate = {};
  if (d.fenetre !== "") p.dashboard_window_days = Number(d.fenetre);
  if (d.anomalie !== "") p.anomaly_new_age_hours = Number(d.anomalie);
  return p;
}

/**
 * Les deux réglages qui ne concernent QUE cette page.
 *
 * Ils vivaient sous « Moteur », rangés dans une section « Observabilité » — alors que leur
 * propre libellé disait déjà « sans effet sur le triage ». On allait donc régler la
 * profondeur d'un graphique dans l'écran des bornes de sécurité du moteur.
 *
 * Un écran de lecture qui règle SON PROPRE affichage ne devient pas pour autant un écran de
 * configuration : rien ici ne touche au comportement du moteur, et c'est précisément ce qui
 * justifie que ça n'ait plus rien à faire ailleurs.
 */
function ReglagesDeLaVue({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const cfg = useConfigDraft(
    toVueDraft,
    toVuePayload,
    tr(
      "Réglages d'affichage enregistrés. Cette page les applique dès la relecture.",
      "Display settings saved. This page applies them on reload.",
    ),
  );
  const { draft, patch } = cfg;

  async function enregistrer() {
    await cfg.save();
    onSaved();
  }

  return (
    <Card className="overflow-hidden">
      <PanelHead
        title={
          <span className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
            {t("Réglages de cette page", "Settings for this page")}
          </span>
        }
        subtitle={t(
          "Profondeur d'analyse et seuil d'anomalie — sans effet sur le triage.",
          "Analysis depth and anomaly threshold — no effect on triage.",
        )}
      />
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            htmlFor="cfg-window-days"
            label={t("Fenêtre (jours)", "Window (days)")}
            hint={t(
              "Profondeur d'historique analysée par les métriques ci-dessus.",
              "History depth analysed by the metrics above.",
            )}
          >
            <Input
              id="cfg-window-days"
              type="number"
              min="1"
              max="365"
              value={draft.fenetre}
              placeholder="7"
              onChange={(e) => patch({ fenetre: e.target.value })}
            />
          </Field>
          <Field
            htmlFor="cfg-anomaly-hours"
            label={t(
              "Anomalie : âge max d'un ticket « New » (h)",
              "Anomaly: max age of a “New” ticket (h)",
            )}
            hint={t(
              "Au-delà de cette ancienneté, un ticket resté « New » est signalé comme anomalie. Signalement seul : aucune action sur le ticket.",
              "Beyond this age, a ticket still “New” is flagged as an anomaly. Flagging only: no action on the ticket.",
            )}
          >
            <Input
              id="cfg-anomaly-hours"
              type="number"
              min="1"
              max="720"
              value={draft.anomalie}
              placeholder="24"
              onChange={(e) => patch({ anomalie: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-3">
          <p className="text-body text-muted-foreground">
            {cfg.dirty
              ? t("Modifications non enregistrées.", "Unsaved changes.")
              : t("Tout est enregistré.", "Everything is saved.")}
          </p>
          <Button onClick={enregistrer} disabled={!cfg.config || cfg.saving || !cfg.dirty}>
            {cfg.saving ? t("Enregistrement…", "Saving…") : t("Enregistrer", "Save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function Dashboard() {
  const t = useT();
  const metrics = useResource(useCallback(() => Api.metrics(), []));
  const ops = useResource(useCallback(() => Api.operationalMetrics(), []));
  // Aperçu = 8 lignes : inutile de télécharger les 500 dernières décisions pour ça.
  const decisions = useResource(useCallback(() => Api.decisions(PREVIEW_ROWS), []));

  // Locale de formatage des nombres : source unique (lib/i18n), comme partout ailleurs.
  const locale = useLocale();
  const m = metrics.data;
  const opView = ops.data ?? null;
  const op = opView?.metrics ?? null;
  const series = m?.series ?? [];
  const totals = series.map((d) => d.accepted + d.a_trier);
  const handled = series.map((d) => d.accepted);
  const aTrier = series.map((d) => d.a_trier);
  const pct = (n: number) => (m?.total ? Math.round((n / m.total) * 100) : 0);
  const num = (n: number) => n.toLocaleString(locale);

  // Coût : le backend arrondit à 4 décimales (« 1.8325 € » à l'écran sans formatage).
  // `?? 0` confondait « pas de plafond » et « plafond INCONNU » (/api/metrics en échec) :
  // la carte affirmait alors « aucun plafond configuré » sans avoir rien lu. Nullable.
  const cost = m?.cost_eur_last_24h ?? null;
  const cap = m?.cost_cap_eur_per_day ?? null;
  const money = (v: number) =>
    `${v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const capPct = cost != null && cap != null && cap > 0 ? Math.round((cost / cap) * 100) : null;
  const overCap = capPct != null && capPct >= 100;

  // GET en échec : on le signale au lieu d'afficher des « — » muets partout.
  const loadError = metrics.error ?? ops.error ?? decisions.error;
  const refreshing = metrics.loading || ops.loading || decisions.loading;
  const reloadAll = useCallback(() => {
    metrics.reload();
    ops.reload();
    decisions.reload();
  }, [metrics.reload, ops.reload, decisions.reload]);

  // Motifs de refus : `by_reason` porte aussi `accepted`, qui n'est pas un motif de refus.
  const reasons = Object.entries(m?.by_reason ?? {}).filter(([r, n]) => r !== "accepted" && n > 0);
  const reasonTotal = reasons.reduce((s, [, n]) => s + n, 0);

  const metricsLoading = metrics.loading && !m;
  const opLoading = ops.loading && !opView;
  const seriesTotal = totals.reduce((s, n) => s + n, 0);

  /**
   * Tendance — QUATRE états distincts. `daily_series` renvoie toujours 14 points (zéros
   * compris) : tester `series.length` ne détectait que `data === null`, donc « pas encore
   * de données » s'affichait pendant le chargement et pendant une erreur, et jamais quand
   * il n'y avait réellement rien (14 barres invisibles, sans un mot).
   */
  let trend: ReactNode;
  if (metricsLoading) {
    trend = <Skeleton className="h-[120px] w-full" />;
  } else if (metrics.error) {
    trend = (
      <Banner kind="error" role="alert">
        {t("Tendance indisponible :", "Trend unavailable:")} {metrics.error}
      </Banner>
    );
  } else if (seriesTotal === 0) {
    trend = (
      <EmptyState
        icon={ListChecks}
        title={t("Aucun ticket analysé sur 14 jours", "No ticket analyzed in 14 days")}
        description={t(
          "Le moteur n'a rien enregistré sur la période. Vérifie que le polling tourne et que GLPI est joignable.",
          "The engine recorded nothing over the period. Check that polling is running and GLPI is reachable.",
        )}
        action={
          <Link to="/status" className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("Voir l'état du moteur", "Check engine status")}
          </Link>
        }
      />
    );
  } else {
    trend = <StackedBars data={series} />;
  }

  return (
    <div className="space-y-4">
      {loadError && (
        <Banner kind="error">
          {t("Données du tableau de bord indisponibles :", "Dashboard data unavailable:")}{" "}
          {loadError}
        </Banner>
      )}

      {/* Cadrage + rafraîchissement manuel. La page charge UNE fois : afficher un badge
          « live » au-dessus de compteurs figés était le mensonge le plus visible ici. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-body text-muted-foreground">
          {t(
            "Compteurs cumulés depuis la mise en service — seule la tendance ci-dessous couvre les 14 derniers jours. Cette page ne se rafraîchit pas toute seule.",
            "Counters are cumulative since first run — only the trend below covers the last 14 days. This page does not refresh on its own.",
          )}
        </p>
        <Button variant="outline" size="sm" onClick={reloadAll} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4${refreshing ? " animate-spin" : ""}`} />{" "}
          {refreshing ? t("Vérification…", "Checking…") : t("Rafraîchir", "Refresh")}
        </Button>
      </div>

      {/* 5 cartes KPI */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label={t("Tickets analysés", "Analyzed tickets")}
          value={m ? num(m.total) : "—"}
          loading={metricsLoading}
        >
          <Sparkline values={totals} />
        </KpiCard>
        <KpiCard
          label={t("Traités", "Handled")}
          value={m ? num(m.accepted) : "—"}
          tag={m ? `${pct(m.accepted)}%` : undefined}
          tagClass="text-success"
          loading={metricsLoading}
        >
          {/* Décompte quotidien des traités — la sparkline traçait un POURCENTAGE
              (`coverage`) sous une valeur annoncée en nombre de tickets. */}
          <Sparkline values={handled} />
        </KpiCard>
        <KpiCard
          label={t("À trier", "To triage")}
          value={m ? num(m.a_trier) : "—"}
          tag={m ? `${pct(m.a_trier)}%` : undefined}
          tagClass="text-warning"
          loading={metricsLoading}
        >
          <Sparkline values={aTrier} />
        </KpiCard>
        <KpiCard
          label={t("Coût LLM (24 h)", "LLM cost (24h)")}
          value={cost != null ? money(cost) : "—"}
          tag={
            m
              ? capPct != null
                ? `${capPct}% ${t("du plafond", "of cap")}`
                : t("sans plafond", "no cap")
              : undefined
          }
          tagClass={overCap ? "text-destructive" : "text-muted-foreground"}
          loading={metricsLoading}
        >
          {/* Il n'existe AUCUNE série de coût côté API : la sparkline d'origine traçait
              ici la série tickets/jour. Une jauge vers le plafond dit, elle, la vérité.
              Rien n'est peint tant que les métriques ne sont pas là : sous un « — »,
              « aucun plafond configuré » et une jauge à 0 % sont deux affirmations que
              la page n'a pas mesurées (/api/metrics en erreur). */}
          {m && cap != null && (
            <div className="mt-3 space-y-1">
              {cap > 0 && cost != null ? (
                <>
                  <ProgressBar
                    ratio={cost / cap}
                    label={t("Consommation du plafond", "Cap consumption")}
                    tone={
                      overCap
                        ? "destructive"
                        : capPct != null && capPct >= 80
                          ? "warning"
                          : "primary"
                    }
                  />
                  <div className="text-caption text-muted-foreground">
                    {t("plafond", "cap")} {money(cap)}/{t("jour", "day")}
                  </div>
                </>
              ) : (
                <div className="text-caption text-muted-foreground">
                  {t("aucun plafond configuré", "no cap configured")}
                </div>
              )}
            </div>
          )}
        </KpiCard>
        <KpiCard
          label={t("Confiance moy.", "Avg. confidence")}
          // Pourcentage comme dans le Journal et la Sandbox : « 0.87 » ici et « 87% »
          // ailleurs pour la même grandeur oblige le lecteur à convertir de tête.
          value={m?.avg_confidence != null ? `${Math.round(m.avg_confidence * 100)}%` : "—"}
          loading={metricsLoading}
        >
          {/* Pas de jauge sans mesure : peinte à 0 % sous un « — », elle se lisait
              « confiance moyenne nulle » alors que rien n'avait été lu. */}
          {m?.avg_confidence != null && (
            <div className="mt-3">
              <ProgressBar
                ratio={m.avg_confidence}
                label={t("Confiance moyenne", "Average confidence")}
              />
            </div>
          )}
        </KpiCard>
      </div>

      {/* Tendance 14 jours */}
      <Card className="overflow-hidden">
        <PanelHead
          title={t("Tendance sur 14 jours", "14-day trend")}
          subtitle={t("Tickets · traités vs à trier", "Tickets · handled vs to triage")}
          right={
            <div className="flex items-center gap-3 text-caption text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-primary" />
                {t("Traités", "Handled")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-warning/80" />
                {t("À trier", "To triage")}
              </span>
            </div>
          }
        />
        {/* Région NOMMÉE : le squelette, l'erreur et l'état vide de la tendance vivent ici
            et nulle part ailleurs — un lecteur d'écran y navigue, et un test peut
            vérifier CE squelette-là sans compter ceux du reste de la page. */}
        <section aria-label={t("Tendance sur 14 jours", "14-day trend")} className="p-5">
          {trend}
        </section>
      </Card>

      {/* Pourquoi les tickets partent « à trier » — `by_reason` est la seule donnée
          actionnable servie par /api/metrics, et elle était jetée. */}
      <Card className="overflow-hidden">
        <PanelHead
          title={t("Pourquoi ces tickets sont « à trier »", "Why these tickets are “to triage”")}
          subtitle={
            m
              ? `${t("Couverture utile", "Useful coverage")} ${Math.round(m.useful_coverage * 100)}% · ${num(m.a_trier)} ${t("à trier sur", "to triage out of")} ${num(m.total)}`
              : t("Motifs de refus du moteur", "Engine refusal reasons")
          }
        />
        {metricsLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : metrics.error ? (
          <div className="p-5">
            <Banner kind="error" role="alert">
              {t("Motifs indisponibles :", "Reasons unavailable:")} {metrics.error}
            </Banner>
          </div>
        ) : reasons.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title={t("Aucun ticket « à trier »", "No ticket left “to triage”")}
            description={t(
              "Tous les tickets analysés ont été tranchés par le moteur.",
              "Every analyzed ticket was decided by the engine.",
            )}
          />
        ) : (
          <ul className="divide-y divide-border">
            {reasons.map(([reason, n]) => {
              const share = Math.round((n / reasonTotal) * 100);
              return (
                <li key={reason} className="flex items-center gap-3 px-5 py-2.5 text-body">
                  <span className="w-48 shrink-0 truncate" title={reasonLabel(reason, t)}>
                    {reasonLabel(reason, t)}
                  </span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn("block h-full rounded-full", REASON_BAR[reasonTone(reason)])}
                      style={{ width: `${Math.max(2, share)}%` }}
                    />
                  </span>
                  <span className="w-28 shrink-0 text-right font-mono text-body text-muted-foreground">
                    {num(n)} · {share}%
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Journal des décisions (aperçu) */}
      <Card className="overflow-hidden">
        <PanelHead
          title={t("Journal des décisions", "Decision journal")}
          subtitle={t(`${PREVIEW_ROWS} dernières décisions`, `Last ${PREVIEW_ROWS} decisions`)}
          right={
            <Link to="/journal" className={buttonVariants({ variant: "outline", size: "sm" })}>
              {t("Ouvrir le journal", "Open journal")}
            </Link>
          }
        />
        {/* La grille a un plancher d'environ 660px : sans conteneur défilable, les colonnes
            Statut et Confiance sont coupées par l'`overflow-hidden` de la Card sous ~1000px
            de fenêtre — information inaccessible, sans même une barre de défilement. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-body">
            <thead className="border-b border-border text-caption font-medium uppercase tracking-[0.08em] text-muted-foreground">
              <tr>
                <th className="w-[72px] px-5 py-2 text-left font-medium">
                  {t("Ticket", "Ticket")}
                </th>
                <th className="px-5 py-2 text-left font-medium">{t("Sujet", "Subject")}</th>
                <th className="w-[150px] px-5 py-2 text-left font-medium">
                  {t("Catégorie", "Category")}
                </th>
                <th className="w-[140px] px-5 py-2 text-left font-medium">
                  {t("Routage", "Routing")}
                </th>
                <th className="w-[56px] px-5 py-2 text-left font-medium">{t("Urg.", "Urg.")}</th>
                <th className="w-[100px] px-5 py-2 text-left font-medium">
                  {t("Statut", "Status")}
                </th>
                <th className="w-[72px] px-5 py-2 text-left font-medium">{t("Conf.", "Conf.")}</th>
              </tr>
            </thead>
            <tbody>
              {decisions.loading && !decisions.data
                ? [0, 1, 2, 3].map((i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-5 py-2.5" colSpan={7}>
                        <Skeleton className="h-3 w-full" />
                      </td>
                    </tr>
                  ))
                : (decisions.data ?? []).slice(0, PREVIEW_ROWS).map((d) => (
                    <tr key={d.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-2 font-mono">
                        {d.glpi_link ? (
                          <a
                            className="text-primary hover:underline"
                            href={d.glpi_link}
                            target="_blank"
                            rel="noreferrer"
                          >
                            #{d.ticket_id}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">#{d.ticket_id}</span>
                        )}
                      </td>
                      <td className="px-5 py-2">
                        <div className="max-w-[280px] truncate" title={d.subject}>
                          {d.subject && d.glpi_link ? (
                            <a
                              className="text-primary hover:underline"
                              href={d.glpi_link}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {d.subject}
                            </a>
                          ) : (
                            d.subject || d.annotation || "—"
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-2 text-muted-foreground">
                        <div className="truncate" title={d.category_name ?? undefined}>
                          {d.category_name ?? (d.category != null ? `#${d.category}` : "—")}
                        </div>
                      </td>
                      <td className="px-5 py-2">
                        <div className="truncate">
                          {d.technician_id != null ? (
                            <Tag tone="indigo">{d.technician_name ?? `T#${d.technician_id}`}</Tag>
                          ) : d.group_id != null ? (
                            <Tag tone="indigo">{d.group_name ?? `G#${d.group_id}`}</Tag>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-2 font-mono text-muted-foreground">
                        {d.urgency ?? "—"}
                      </td>
                      <td className="px-5 py-2">
                        {d.accepted ? (
                          <Tag tone="green">{t("traité", "handled")}</Tag>
                        ) : (
                          <Tag tone="amber">{t("à trier", "to triage")}</Tag>
                        )}
                      </td>
                      <td className="px-5 py-2 font-mono">
                        {/* Pourcentage : le Journal affiche « 87% » pour la même grandeur. */}
                        {d.confidence != null ? `${Math.round(d.confidence * 100)}%` : "—"}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        {/* Journal en échec : le tableau ne rendait QUE ses en-têtes, sans un mot — un
            journal vide et un journal illisible se ressemblaient trait pour trait. */}
        {decisions.error ? (
          <div className="p-5">
            <Banner kind="error" role="alert">
              {t("Journal indisponible :", "Journal unavailable:")} {decisions.error}
            </Banner>
          </div>
        ) : (
          decisions.data?.length === 0 && (
            <EmptyState
              icon={ScrollText}
              title={t("Aucune décision pour le moment", "No decisions yet")}
              description={t(
                "Les tickets traités et les « à trier » s'afficheront ici.",
                "Handled tickets and “to triage” entries will appear here.",
              )}
            />
          )
        )}
      </Card>

      {/* Opérationnel GLPI (FR-23) — métriques d'équipe, jamais par personne */}
      <Card className="overflow-hidden">
        <PanelHead
          title={t("Opérationnel (GLPI)", "Operational (GLPI)")}
          subtitle={
            op
              ? `${t("Métriques d'équipe", "Team metrics")} · ${op.window_days} ${t("j", "d")} · ${op.tickets_in_window} ${t("tickets dans la fenêtre", "tickets in window")}`
              : t("Métriques d'équipe — jamais par personne", "Team metrics — never per person")
          }
        />
        {opView && !opView.available ? (
          <EmptyState
            icon={ListChecks}
            title={t("Métriques GLPI indisponibles", "GLPI metrics unavailable")}
            description={
              opView.detail ||
              t(
                "GLPI est injoignable ou non configuré. Renseigne la connexion dans Configuration.",
                "GLPI is unreachable or not configured. Set the connection in Configuration.",
              )
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
              {[
                {
                  label: t("Temps 1ʳᵉ réponse", "First response time"),
                  value:
                    op?.first_response_median_minutes != null
                      ? `${op.first_response_median_minutes} min`
                      : "—",
                  hint:
                    op?.first_response_median_minutes != null
                      ? t("médian sur la fenêtre", "median in window")
                      : t("aucune prise en compte horodatée", "no timestamped pickup"),
                },
                {
                  label: t("Respect SLA", "SLA compliance"),
                  value:
                    op?.sla_compliance_rate != null
                      ? `${Math.round(op.sla_compliance_rate * 100)}%`
                      : "—",
                  hint:
                    op && op.sla_evaluated > 0
                      ? `${op.sla_evaluated} ${t("ticket(s) avec SLA", "ticket(s) with SLA")}`
                      : t("aucune échéance SLA dans GLPI", "no SLA deadline in GLPI"),
                },
                {
                  // `reassignment_rate` / `reassignment_available` sont servis : un « n/d »
                  // codé en dur mentait dès que l'historique GLPI était lisible.
                  label: t("Réaffectation", "Reassignment"),
                  value:
                    op?.reassignment_rate != null
                      ? `${Math.round(op.reassignment_rate * 100)}%`
                      : t("n/d", "n/a"),
                  hint: op?.reassignment_available
                    ? t("part des tickets réassignés", "share of reassigned tickets")
                    : t("historique GLPI requis (Log)", "GLPI history required (Log)"),
                },
                {
                  label: t("Anomalies", "Anomalies"),
                  value: op ? String(op.anomalies.length) : "—",
                  hint: op
                    ? t("tickets en alerte sur la fenêtre", "flagged tickets in window")
                    : "",
                },
              ].map((s) => (
                <KpiCard
                  key={s.label}
                  variant="cell"
                  label={s.label}
                  value={s.value}
                  hint={s.hint || undefined}
                  loading={opLoading}
                />
              ))}
            </div>
            {op && op.anomalies.length > 0 && (
              <div className="border-t border-border">
                {op.anomalies.slice(0, ANOMALY_LIMIT).map((a) => (
                  <div
                    key={`${a.ticket_id}-${a.kind}`}
                    className="flex items-center gap-3 border-b border-border/50 px-5 py-2 text-body last:border-0"
                  >
                    {a.glpi_link ? (
                      <a
                        className="font-mono text-primary hover:underline"
                        href={a.glpi_link}
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{a.ticket_id}
                      </a>
                    ) : (
                      <span className="font-mono text-muted-foreground">#{a.ticket_id}</span>
                    )}
                    <Tag tone={a.kind === "sla_breached" ? "red" : "amber"}>
                      {a.kind === "sla_breached"
                        ? t("SLA dépassé", "SLA breached")
                        : t("« New » ancien", "stale “New”")}
                    </Tag>
                    <span className="truncate text-muted-foreground">{a.detail}</span>
                  </div>
                ))}
                {/* Borne : 300 SLA dépassés ne déroulent pas 300 lignes sur l'accueil. */}
                {op.anomalies.length > ANOMALY_LIMIT && (
                  <div className="border-t border-border px-5 py-2 text-body text-muted-foreground">
                    + {num(op.anomalies.length - ANOMALY_LIMIT)}{" "}
                    {t("autres anomalies", "other anomalies")}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Card>

      {/* En dernier, sous la carte qu'ils règlent : la fenêtre d'analyse et le seuil
          d'anomalie pilotent « Opérationnel (GLPI) » juste au-dessus. */}
      <ReglagesDeLaVue
        onSaved={() => {
          // Les métriques sont calculées SERVEUR avec ces bornes : sans relecture, la page
          // afficherait encore la fenêtre précédente en annonçant la nouvelle.
          metrics.reload();
          ops.reload();
        }}
      />
    </div>
  );
}
