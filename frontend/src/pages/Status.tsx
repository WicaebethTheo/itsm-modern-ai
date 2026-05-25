import { type ReactNode, useCallback } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-2.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

export function Status() {
  const status = useResource(useCallback(() => Api.status(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const s = status.data;
  const h = health.data;

  return (
    <>
      <PageHeader
        title="Statut"
        description="État du moteur, du polling et des compteurs."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              status.reload();
              health.reload();
            }}
          >
            Rafraîchir
          </Button>
        }
      />
      <Card>
        <CardContent className="p-5">
          <Row label="Santé globale" value={h?.status ?? "—"} />
          <Row label="GLPI configuré" value={String(h?.glpi.configured ?? "—")} />
          <Row label="GLPI joignable" value={String(h?.glpi.reachable ?? "—")} />
          <Row label="LLM configuré" value={String(h?.llm.configured ?? "—")} />
          <Row label="Polling" value={s?.polling_enabled ? `actif (${s.polling_interval_seconds}s)` : "inactif"} />
          <Row label="Whitelist chargée" value={String(s?.whitelist_loaded ?? "—")} />
          <Row label="Catégories" value={s?.categories_count ?? "—"} />
          <Row label="Techniciens" value={s?.technicians_count ?? "—"} />
          <Row label="Appels LLM (total)" value={s?.llm_calls_total ?? "—"} />
          <Row
            label="Coût 24 h / plafond"
            value={s ? `${s.cost_eur_last_24h} € / ${s.cost_cap_eur_per_day} €` : "—"}
          />
        </CardContent>
      </Card>
    </>
  );
}
