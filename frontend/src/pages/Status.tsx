import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { Button } from "@/components/ui/button";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { Activity, Bot, Coins, Cpu, ListChecks, PlugZap, Timer } from "lucide-react";
import { useCallback } from "react";

export function Status() {
  const status = useResource(useCallback(() => Api.status(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const s = status.data;
  const h = health.data;

  const glpiTone = !h?.glpi.configured ? "warn" : h.glpi.reachable ? "success" : "destructive";
  const overCap = s && s.cost_cap_eur_per_day > 0 && s.cost_eur_last_24h >= s.cost_cap_eur_per_day;

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

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        <StatCard
          label="Santé globale"
          icon={Activity}
          tone={h?.status === "ok" ? "success" : "warn"}
          value={h?.status === "ok" ? "OK" : h ? "Dégradé" : "—"}
        />
        <StatCard
          label="Connexion GLPI"
          icon={PlugZap}
          tone={glpiTone}
          value={
            !h?.glpi.configured ? "non configurée" : h.glpi.reachable ? "joignable" : "injoignable"
          }
        />
        <StatCard
          label="Fournisseur IA"
          icon={Bot}
          tone={h?.llm.configured ? "success" : "warn"}
          value={h?.llm.configured ? "configuré" : "clé absente"}
        />
        <StatCard
          label="Polling"
          icon={Timer}
          tone={s?.polling_enabled ? "success" : "warn"}
          value={s?.polling_enabled ? "actif" : "inactif"}
          hint={s ? `intervalle ${s.polling_interval_seconds}s` : undefined}
        />
        <StatCard
          label="Whitelist"
          icon={ListChecks}
          tone={s?.whitelist_loaded ? "primary" : "default"}
          value={s ? `${s.categories_count} / ${s.technicians_count}` : "—"}
          hint="catégories / techniciens"
        />
        <StatCard
          label="Appels LLM (total)"
          icon={Cpu}
          value={s ? s.llm_calls_total.toLocaleString("fr-FR") : "—"}
        />
        <StatCard
          label="Coût LLM (24 h)"
          icon={Coins}
          tone={overCap ? "destructive" : "default"}
          value={s ? `${s.cost_eur_last_24h} €` : "—"}
          hint={s ? `plafond ${s.cost_cap_eur_per_day} €/j` : undefined}
        />
      </div>
    </>
  );
}
