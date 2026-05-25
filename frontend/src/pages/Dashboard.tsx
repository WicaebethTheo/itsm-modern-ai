import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { useCallback } from "react";

export function Dashboard() {
  const metrics = useResource(useCallback(() => Api.metrics(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const status = useResource(useCallback(() => Api.status(), []));
  const ops = useResource(useCallback(() => Api.operationalMetrics(), []));

  const m = metrics.data;
  const h = health.data;
  const s = status.data;
  const op = ops.data?.metrics ?? null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Vue d'équipe, orientée santé opérationnelle. Aucune métrique par technicien."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Connexion GLPI"
          value={
            !h?.glpi.configured ? (
              <Badge variant="warn">non configurée</Badge>
            ) : h.glpi.reachable ? (
              <Badge variant="success">joignable</Badge>
            ) : (
              <Badge variant="destructive">injoignable</Badge>
            )
          }
        />
        <StatCard
          label="Fournisseur IA"
          value={
            h?.llm.configured ? (
              <Badge variant="success">configuré</Badge>
            ) : (
              <Badge variant="warn">clé absente</Badge>
            )
          }
        />
        <StatCard
          label="Whitelist"
          value={s ? `${s.categories_count} / ${s.technicians_count}` : "—"}
          hint="catégories / techniciens"
        />
        <StatCard
          label="Polling"
          value={s?.polling_enabled ? "actif" : "inactif"}
          hint={s ? `${s.polling_interval_seconds}s` : undefined}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Décisions au total" value={m?.total ?? "—"} />
        <StatCard
          label="Couverture utile"
          value={m ? `${Math.round(m.useful_coverage * 100)}%` : "—"}
          hint={m ? `${m.accepted} déposées · ${m.a_trier} « à trier »` : undefined}
        />
        <StatCard
          label="Coût LLM (24 h)"
          value={m ? `${m.cost_eur_last_24h} €` : "—"}
          hint={m ? `plafond ${m.cost_cap_eur_per_day} €/j · ${m.llm_calls} appels` : undefined}
        />
      </div>

      <h2 className="mt-8 text-lg font-semibold">Dashboard inversé (GLPI)</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Métriques d'équipe sur {op ? `${op.window_days} j` : "la fenêtre"} — jamais par personne. En
        mode suggestion, elles mesurent l'activité de l'équipe, pas l'effet de l'outil.
      </p>
      {ops.data && !ops.data.available ? (
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            Indisponible : {ops.data.detail || "connectez GLPI pour activer ces métriques."}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard
              label="Temps 1ʳᵉ réponse (médian)"
              value={
                op?.first_response_median_minutes != null
                  ? `${op.first_response_median_minutes} min`
                  : "—"
              }
            />
            <StatCard
              label="Respect SLA"
              value={
                op?.sla_compliance_rate != null
                  ? `${Math.round(op.sla_compliance_rate * 100)}%`
                  : "—"
              }
              hint={op ? `${op.sla_evaluated} ticket(s) évalué(s)` : undefined}
            />
            <StatCard
              label="Taux de réaffectation"
              value="n/d"
              hint="nécessite l'historique GLPI"
            />
            <StatCard label="Anomalies" value={op?.anomalies.length ?? "—"} />
          </div>
          {op && op.anomalies.length > 0 && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Anomalies</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-1.5">
                  {op.anomalies.slice(0, 20).map((a) => (
                    <div
                      key={`${a.ticket_id}-${a.kind}`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Badge variant="warn">#{a.ticket_id}</Badge>
                      <span className="text-muted-foreground">{a.detail}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Répartition des résultats</CardTitle>
        </CardHeader>
        <CardContent>
          {metrics.error && <p className="text-sm text-destructive">{metrics.error}</p>}
          {m && Object.keys(m.by_reason).length === 0 && (
            <p className="text-sm text-muted-foreground">
              Aucune décision enregistrée pour le moment.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            {m &&
              Object.entries(m.by_reason).map(([reason, n]) => (
                <div key={reason} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{reason}</span>
                  <span className="font-medium">{n}</span>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
