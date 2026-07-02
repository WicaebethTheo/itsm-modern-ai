import { Card } from "@/components/ui/card";
import { Dot, type DotTone } from "@/components/ui/dot";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useCallback } from "react";

function ServicePanel({
  name,
  state,
  meta,
  tone,
}: {
  name: string;
  state: string;
  meta: string;
  tone: DotTone;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">{name}</span>
        <Dot tone={tone} />
      </div>
      <div className="mt-2 text-[18px] font-semibold tracking-tight">{state}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{meta}</div>
    </Card>
  );
}

export function Status() {
  const t = useT();
  const status = useResource(useCallback(() => Api.status(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const s = status.data;
  const h = health.data;

  // Champs enrichis renvoyés seulement avec une session admin (la page est derrière
  // RequireAuth, mais on reste défensif : le type les déclare optionnels).
  const overCap =
    s?.cost_cap_eur_per_day != null &&
    s.cost_eur_last_24h != null &&
    s.cost_cap_eur_per_day > 0 &&
    s.cost_eur_last_24h >= s.cost_cap_eur_per_day;

  const services: { name: string; state: string; meta: string; tone: DotTone }[] = [
    {
      name: t("Worker (moteur)", "Worker (engine)"),
      state: s?.polling_enabled ? t("En marche", "Running") : t("En pause", "Paused"),
      meta:
        s?.polling_interval_seconds != null
          ? t(
              `cycle toutes les ${s.polling_interval_seconds}s`,
              `cycle every ${s.polling_interval_seconds}s`,
            )
          : "—",
      tone: s?.polling_enabled ? "green" : "amber",
    },
    {
      name: t("API GLPI", "GLPI API"),
      state: !h?.glpi.configured
        ? t("Non configurée", "Not configured")
        : h.glpi.reachable
          ? t("Connecté", "Connected")
          : t("Injoignable", "Unreachable"),
      meta: t("API legacy (apirest.php)", "Legacy API (apirest.php)"),
      tone: !h?.glpi.configured ? "muted" : h.glpi.reachable ? "green" : "red",
    },
    {
      name: t("Fournisseur IA", "AI provider"),
      state: h?.llm.configured ? t("Configuré", "Configured") : t("Clé absente", "No key"),
      meta: t("LLM du moteur (avant garde-fou)", "engine LLM (before guardrail)"),
      tone: h?.llm.configured ? "green" : "amber",
    },
    {
      name: t("Base de données", "Database"),
      state: h ? t("Saine", "Healthy") : "—",
      meta: "SQLite",
      tone: h ? "green" : "muted",
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
