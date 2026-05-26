import { ProgressBar, Sparkline, StackedBars } from "@/components/Charts";
import { EmptyState } from "@/components/EmptyState";
import { Card } from "@/components/ui/card";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback } from "react";

/** Carte KPI (label 11.5px + valeur 22px + tag coloré + sparkline) — style maquette. */
function KpiCard({
  label,
  value,
  tag,
  tagClass = "text-muted-foreground",
  children,
}: {
  label: string;
  value: string;
  tag?: string;
  tagClass?: string;
  children?: ReactNode;
}) {
  return (
    <Card className="p-3.5">
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[22px] font-semibold tracking-tight">{value}</span>
        {tag && <span className={`text-[11px] ${tagClass}`}>{tag}</span>}
      </div>
      {children}
    </Card>
  );
}

export function Dashboard() {
  const t = useT();
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
  const pct = (n: number) => (m?.total ? Math.round((n / m.total) * 100) : 0);

  return (
    <div className="space-y-4">
      {/* 5 cartes KPI */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label={t("Décisions", "Decisions")}
          value={m ? m.total.toLocaleString("fr-FR") : "—"}
        >
          <Sparkline values={totals} />
        </KpiCard>
        <KpiCard
          label={t("Déposées", "Deposited")}
          value={m ? m.accepted.toLocaleString("fr-FR") : "—"}
          tag={m ? `${pct(m.accepted)}%` : undefined}
          tagClass="text-success"
        >
          <Sparkline values={coverage} />
        </KpiCard>
        <KpiCard
          label={t("À trier", "To triage")}
          value={m ? m.a_trier.toLocaleString("fr-FR") : "—"}
          tag={m ? `${pct(m.a_trier)}%` : undefined}
        >
          <Sparkline values={aTrier} />
        </KpiCard>
        <KpiCard
          label={t("Coût LLM (24 h)", "LLM cost (24h)")}
          value={m ? `${m.cost_eur_last_24h} €` : "—"}
          tag={m ? `${t("plafond", "cap")} ${m.cost_cap_eur_per_day} €` : undefined}
        >
          <Sparkline values={totals} />
        </KpiCard>
        <KpiCard
          label={t("Confiance moy.", "Avg. confidence")}
          value={m?.avg_confidence != null ? m.avg_confidence.toFixed(2) : "—"}
        >
          <div className="mt-3">
            <ProgressBar ratio={m?.avg_confidence ?? 0} />
          </div>
        </KpiCard>
      </div>

      {/* Tendance 14 jours */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-medium">
              {t("Tendance sur 14 jours", "14-day trend")}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t("Décisions · déposées vs à trier", "Decisions · deposited vs to triage")}
            </div>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#6366f1" }} />
              {t("Déposées", "Deposited")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#3d3f8a" }} />
              {t("À trier", "To triage")}
            </span>
          </div>
        </div>
        {series.length ? (
          <StackedBars data={series} />
        ) : (
          <EmptyState icon={ListChecks} title={t("Pas encore de données", "No data yet")} />
        )}
      </Card>

      {/* Journal des décisions (aperçu) */}
      <Card className="overflow-hidden">
        <PanelHead
          title={t("Journal des décisions", "Decision journal")}
          right={<span className="font-mono text-[11px] text-muted-foreground">live</span>}
        />
        <div className="text-[12px]">
          <div
            className="grid gap-3 border-b border-border px-4 py-2 text-[11px] uppercase text-muted-foreground"
            style={{ gridTemplateColumns: "80px 1fr 130px 110px 70px", letterSpacing: "0.08em" }}
          >
            <span>{t("Ticket", "Ticket")}</span>
            <span>{t("Sujet", "Subject")}</span>
            <span>{t("Routage", "Routing")}</span>
            <span>{t("Statut", "Status")}</span>
            <span>{t("Conf.", "Conf.")}</span>
          </div>
          {(decisions.data ?? []).slice(0, 8).map((d, i, arr) => (
            <div
              key={d.id}
              className={`grid items-center gap-3 px-4 py-2 ${i < arr.length - 1 ? "border-b border-border" : ""}`}
              style={{ gridTemplateColumns: "80px 1fr 130px 110px 70px" }}
            >
              <span className="font-mono text-muted-foreground">#{d.ticket_id}</span>
              <span className="truncate">{d.annotation || "—"}</span>
              <span>
                {d.technician_id != null ? (
                  <Tag tone="indigo">T#{d.technician_id}</Tag>
                ) : d.group_id != null ? (
                  <Tag tone="indigo">G#{d.group_id}</Tag>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
              <span>
                {d.accepted ? (
                  <Tag tone="green">{t("déposée", "deposited")}</Tag>
                ) : (
                  <Tag tone="amber">{t("à trier", "to triage")}</Tag>
                )}
              </span>
              <span className="font-mono">
                {d.confidence != null ? d.confidence.toFixed(2) : "—"}
              </span>
            </div>
          ))}
          {decisions.data?.length === 0 && (
            <div className="px-4 py-8">
              <EmptyState
                icon={ListChecks}
                title={t("Aucune décision pour le moment", "No decisions yet")}
              />
            </div>
          )}
        </div>
      </Card>

      {/* Opérationnel GLPI (FR-23) — métriques d'équipe, jamais par personne */}
      <Card className="overflow-hidden">
        <PanelHead
          title={t("Opérationnel (GLPI)", "Operational (GLPI)")}
          subtitle={t(
            "Métriques d'équipe — jamais par personne",
            "Team metrics — never per person",
          )}
        />
        <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
          {[
            {
              label: t("Temps 1ʳᵉ réponse", "First response time"),
              value:
                op?.first_response_median_minutes != null
                  ? `${op.first_response_median_minutes} min`
                  : "—",
              hint: t("médian", "median"),
            },
            {
              label: t("Respect SLA", "SLA compliance"),
              value:
                op?.sla_compliance_rate != null
                  ? `${Math.round(op.sla_compliance_rate * 100)}%`
                  : "—",
              hint: op ? `${op.sla_evaluated} ${t("évalués", "evaluated")}` : "",
            },
            {
              label: t("Réaffectation", "Reassignment"),
              value: "n/d",
              hint: t("historique GLPI requis", "GLPI history required"),
            },
            {
              label: t("Anomalies", "Anomalies"),
              value: op ? String(op.anomalies.length) : "—",
              hint: "",
            },
          ].map((s) => (
            <div key={s.label} className="bg-card p-4">
              <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground/80">
                {s.label}
              </div>
              <div className="mt-1.5 text-[22px] font-semibold tracking-tight">{s.value}</div>
              {s.hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{s.hint}</div>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
