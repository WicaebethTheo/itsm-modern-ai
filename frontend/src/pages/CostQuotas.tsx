import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { useLang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Gauge, Settings, TrendingUp, Wallet } from "lucide-react";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

/** Symbole monétaire — EUR → €, fallback : code ISO tel quel. */
function currencySymbol(currency: string): string {
  return currency === "EUR" ? "€" : currency;
}

/** Formate un montant « 1,83 € » (locale FR/EN selon `lang`, symbole d'après la devise). */
function formatMoney(amount: number, currency: string, lang: "fr" | "en"): string {
  const sym = currencySymbol(currency);
  const n = amount.toLocaleString(lang === "fr" ? "fr-FR" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return lang === "fr" ? `${n} ${sym}` : `${sym}${n}`;
}

/** Carte KPI — label 11.5px + valeur 22px + icône, calquée sur le Dashboard. */
function KpiCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="p-3.5">
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
        {label}
      </div>
      <div className="mt-1.5 text-[22px] font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export function CostQuotas() {
  const t = useT();
  const { lang } = useLang();
  const navigate = useNavigate();
  const cost = useResource(useCallback(() => Api.cost(), []));
  const c = cost.data;

  const noCap = c != null && c.cost_cap_eur_per_day === 0;
  // Pourcentage borné visuellement à 0–100 pour la barre (la valeur réelle peut dépasser).
  const pct = c?.pct_of_cap ?? 0;
  const pctClamped = Math.min(100, Math.max(0, pct));
  // Couleur : rouge si plafond atteint, ambre ≥ 70 %, vert sinon.
  const barColor = c?.over_cap ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-success";

  return (
    <div className="space-y-4">
      {/* En-tête */}
      <div className="space-y-0.5 px-1">
        <h1 className="text-[18px] font-semibold tracking-tight">
          {t("Coûts & quotas", "Cost & quotas")}
        </h1>
        <p className="text-[12.5px] text-muted-foreground">
          {t(
            "Dépense LLM des dernières 24 h et plafond journalier glissant.",
            "LLM spend over the last 24h and the rolling daily cap.",
          )}
        </p>
      </div>

      {cost.error ? (
        <Banner kind="error">
          {t("Erreur de chargement", "Failed to load")} : {cost.error}
        </Banner>
      ) : null}

      {/* Bannière plafond atteint — calque le comportement du moteur (cost_cap). */}
      {c?.over_cap ? (
        <Banner kind="error">
          {t(
            "⚠ Plafond de coût journalier atteint : les appels LLM facturables sont en pause. Les nouveaux tickets partent « à trier » jusqu'à la reprise (fenêtre glissante de 24 h ou plafond relevé).",
            "⚠ Daily cost cap reached: billable LLM calls are paused. New tickets go « to triage » until it resumes (rolling 24h window or a raised cap).",
          )}
        </Banner>
      ) : null}

      {/* Cartes KPI */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiCard
          icon={<Wallet />}
          label={t("Dépense (24 h)", "Spend (24h)")}
          value={c ? formatMoney(c.spent_eur_last_24h, c.currency, lang) : "—"}
          hint={t("Estimée d'après les tarifs configurés", "Estimated from configured tariffs")}
        />
        <KpiCard
          icon={<Gauge />}
          label={t("Plafond journalier", "Daily cap")}
          value={
            c
              ? noCap
                ? t("Aucun plafond", "No cap")
                : formatMoney(c.cost_cap_eur_per_day, c.currency, lang)
              : "—"
          }
          hint={
            c && noCap
              ? t("Dépense non bornée", "Unbounded spend")
              : t("Par jour (fenêtre glissante)", "Per day (rolling window)")
          }
        />
        <KpiCard
          icon={<TrendingUp />}
          label={t("Appels LLM journalisés", "LLM calls logged")}
          value={c ? c.llm_calls_total.toLocaleString(lang === "fr" ? "fr-FR" : "en-US") : "—"}
        />
      </div>

      {/* Jauge dépense vs plafond (masquée s'il n'y a pas de plafond). */}
      {c && !noCap ? (
        <Card>
          <PanelHead
            title={
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
                  <Gauge />
                </span>
                {t("Consommation du plafond", "Cap consumption")}
              </span>
            }
            subtitle={t(
              "Dépense des dernières 24 h rapportée au plafond journalier.",
              "Last 24h spend relative to the daily cap.",
            )}
            right={
              <Tag tone={c.over_cap ? "red" : pct >= 70 ? "amber" : "green"}>
                {c.pct_of_cap != null ? `${Math.round(c.pct_of_cap)}%` : "—"}
              </Tag>
            }
          />
          <CardContent className="flex flex-col gap-2 p-5">
            {/* Jauge accessible : rôle progressbar + valeurs ARIA (la valeur réelle, non bornée,
                est annoncée via aria-valuetext pour les dépassements > 100 %). */}
            {/* biome-ignore lint/a11y/useFocusableInteractive: progressbar est un rôle ARIA NON
                interactif (WAI-ARIA APG) — il ne doit pas être focusable, donc pas de tabIndex. */}
            <div
              className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
              data-testid="cost-cap-bar"
              role="progressbar"
              aria-label={t("Consommation du plafond", "Cap consumption")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pctClamped)}
              aria-valuetext={c.pct_of_cap != null ? `${Math.round(c.pct_of_cap)}%` : undefined}
            >
              <div
                className={cn("h-full rounded-full transition-all", barColor)}
                style={{ width: `${pctClamped}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[12px] text-muted-foreground">
              <span>{formatMoney(c.spent_eur_last_24h, c.currency, lang)}</span>
              <span>{formatMoney(c.cost_cap_eur_per_day, c.currency, lang)}</span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Tarifs configurés (servent à estimer la dépense). */}
      {c ? (
        <Card>
          <PanelHead
            title={t("Tarifs configurés", "Configured tariffs")}
            subtitle={t(
              "Prix unitaires utilisés pour estimer la dépense (par million de tokens).",
              "Unit prices used to estimate spend (per million tokens).",
            )}
          />
          <CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            <div className="rounded-md border border-border bg-muted/20 p-4">
              <div className="text-[11.5px] text-muted-foreground">{t("Entrée", "Input")}</div>
              <div className="mt-1 text-[18px] font-semibold tracking-tight">
                {formatMoney(c.price_input_per_mtok, c.currency, lang)}{" "}
                <span className="text-[12px] font-normal text-muted-foreground">
                  {t("/ Mtok entrée", "/ Mtok input")}
                </span>
              </div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-4">
              <div className="text-[11.5px] text-muted-foreground">{t("Sortie", "Output")}</div>
              <div className="mt-1 text-[18px] font-semibold tracking-tight">
                {formatMoney(c.price_output_per_mtok, c.currency, lang)}{" "}
                <span className="text-[12px] font-normal text-muted-foreground">
                  {t("/ Mtok sortie", "/ Mtok output")}
                </span>
              </div>
            </div>
            <p className="text-[11.5px] text-muted-foreground sm:col-span-2">
              {t(
                "Ces tarifs sont des estimations indicatives : la facturation réelle dépend du fournisseur LLM.",
                "These tariffs are indicative estimates: real billing depends on the LLM provider.",
              )}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* Renvoi vers le Moteur : le plafond s'édite là-bas (cette page est en lecture seule). */}
      <Card>
        <CardContent className="flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12.5px] text-muted-foreground">
            {t(
              "Le plafond de coût et les tarifs se règlent dans Moteur. Cette page est en lecture seule.",
              "The cost cap and tariffs are set in Engine. This page is read-only.",
            )}
          </p>
          <Button variant="outline" onClick={() => navigate("/engine")}>
            <Settings />
            {t("Régler le plafond dans Moteur", "Set the cap in Engine")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
