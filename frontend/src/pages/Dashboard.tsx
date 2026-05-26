import { ProgressBar, Sparkline, StackedBars } from "@/components/Charts";
import { EmptyState } from "@/components/EmptyState";
import { StatCard } from "@/components/StatCard";
import { useSetHeader } from "@/components/topbar-context";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { Bot, ListChecks, PlugZap, Timer } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback } from "react";

/** Carte KPI avec sparkline / barre de progression (style mockup opérateur). */
function Kpi({
  label,
  value,
  delta,
  children,
}: {
  label: string;
  value: string;
  delta?: { text: string; muted?: boolean };
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className="flex items-end justify-between gap-2">
          <span className="text-[22px] font-semibold tracking-tight">{value}</span>
          {delta && (
            <span
              className={delta.muted ? "text-sm text-muted-foreground" : "text-sm text-success"}
            >
              {delta.text}
            </span>
          )}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function Dashboard() {
  useSetHeader("Tableau de bord", "Vue d'ensemble du triage IA sur 14 jours");
  const metrics = useResource(useCallback(() => Api.metrics(), []));
  const ops = useResource(useCallback(() => Api.operationalMetrics(), []));
  const decisions = useResource(useCallback(() => Api.decisions(), []));

  const m = metrics.data;
  const op = ops.data?.metrics ?? null;
  const series = m?.series ?? [];
  const totals = series.map((d) => d.accepted + d.a_trier);
  const aTrier = series.map((d) => d.a_trier);
  const coverage = series.map((d) =>
    d.accepted + d.a_trier ? Math.round((d.accepted / (d.accepted + d.a_trier)) * 100) : 0,
  );

  return (
    <>
      {/* 5 cartes KPI */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Décisions" value={m ? m.total.toLocaleString("fr-FR") : "—"}>
          <Sparkline values={totals} />
        </Kpi>
        <Kpi
          label="Couverture utile"
          value={m ? `${Math.round(m.useful_coverage * 100)}%` : "—"}
          delta={m ? { text: `${m.accepted} déposées` } : undefined}
        >
          <Sparkline values={coverage} />
        </Kpi>
        <Kpi
          label="À trier"
          value={m ? m.a_trier.toLocaleString("fr-FR") : "—"}
          delta={
            m
              ? { text: `${Math.round((m.a_trier / Math.max(1, m.total)) * 100)}%`, muted: true }
              : undefined
          }
        >
          <Sparkline values={aTrier} />
        </Kpi>
        <Kpi
          label="Coût LLM (24 h)"
          value={m ? `${m.cost_eur_last_24h} €` : "—"}
          delta={m ? { text: `cap ${m.cost_cap_eur_per_day} €`, muted: true } : undefined}
        >
          <Sparkline values={totals} />
        </Kpi>
        <Kpi
          label="Confiance moy."
          value={m?.avg_confidence != null ? m.avg_confidence.toFixed(2) : "—"}
        >
          <ProgressBar ratio={m?.avg_confidence ?? 0} />
        </Kpi>
      </div>

      {/* Tendance 14 jours */}
      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Tendance sur 14 jours</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Décisions · déposées vs « à trier »
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-primary" /> Déposées
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-primary/35" /> À trier
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {series.length ? (
            <StackedBars data={series} />
          ) : (
            <EmptyState icon={ListChecks} title="Pas encore de données" />
          )}
        </CardContent>
      </Card>

      {/* Opérationnel GLPI (FR-23) */}
      <h2 className="mt-8 text-lg font-semibold">Opérationnel (GLPI)</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Métriques d'équipe — jamais par personne. En mode suggestion, elles mesurent l'activité de
        l'équipe, pas l'effet de l'outil.
      </p>
      {ops.data && !ops.data.available ? (
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            Indisponible : {ops.data.detail || "connectez GLPI pour activer ces métriques."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard
            label="Temps 1ʳᵉ réponse"
            icon={Timer}
            tone="primary"
            value={
              op?.first_response_median_minutes != null
                ? `${op.first_response_median_minutes} min`
                : "—"
            }
            hint="médian"
          />
          <StatCard
            label="Respect SLA"
            icon={ListChecks}
            tone="success"
            value={
              op?.sla_compliance_rate != null ? `${Math.round(op.sla_compliance_rate * 100)}%` : "—"
            }
            hint={op ? `${op.sla_evaluated} évalués` : undefined}
          />
          <StatCard
            label="Réaffectation"
            icon={PlugZap}
            value="n/d"
            hint="historique GLPI requis"
          />
          <StatCard
            label="Anomalies"
            icon={Bot}
            tone={op && op.anomalies.length > 0 ? "warn" : "default"}
            value={op ? String(op.anomalies.length) : "—"}
          />
        </div>
      )}

      {/* Journal des décisions (aperçu) */}
      <Card className="mt-6 overflow-hidden">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Journal des décisions</CardTitle>
          <span className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> live
          </span>
        </CardHeader>
        <table className="w-full text-sm">
          <thead className="border-y border-border/60 bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-5 py-2 text-left font-medium">Ticket</th>
              <th className="px-5 py-2 text-left font-medium">Sujet</th>
              <th className="px-5 py-2 text-left font-medium">Routage</th>
              <th className="px-5 py-2 text-right font-medium">Conf.</th>
            </tr>
          </thead>
          <tbody>
            {decisions.data?.slice(0, 8).map((d) => (
              <tr key={d.id} className="border-b border-border/40 last:border-0 hover:bg-accent/40">
                <td className="px-5 py-2.5 font-mono text-xs text-muted-foreground">
                  #{d.ticket_id}
                </td>
                <td className="px-5 py-2.5">{d.annotation || "—"}</td>
                <td className="px-5 py-2.5">
                  {d.accepted ? (
                    <Badge variant={d.group_id ? "default" : "success"}>
                      →{" "}
                      {d.technician_id != null
                        ? `Tech #${d.technician_id}`
                        : d.group_id != null
                          ? `Groupe #${d.group_id}`
                          : "déposée"}
                    </Badge>
                  ) : (
                    <Badge variant="warn">⚠ {d.reason}</Badge>
                  )}
                </td>
                <td className="px-5 py-2.5 text-right font-mono text-xs">
                  {d.confidence != null ? d.confidence.toFixed(2) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {decisions.data?.length === 0 && (
          <EmptyState icon={ListChecks} title="Aucune décision pour le moment" />
        )}
      </Card>
    </>
  );
}
