import { Gauge, RefreshCw, Settings, TrendingUp, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banner } from "@/components/Banner";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { KpiCard, KpiSkeleton } from "@/components/ui/kpi";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { localeFor, useLang, useLocale, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Symbole monétaire — EUR → €, fallback : code ISO tel quel. */
function currencySymbol(currency: string): string {
  return currency === "EUR" ? "€" : currency;
}

/** Formate un montant « 1,83 € » (locale FR/EN selon `lang`, symbole d'après la devise). */
function formatMoney(amount: number, currency: string, lang: "fr" | "en"): string {
  const sym = currencySymbol(currency);
  const n = amount.toLocaleString(localeFor(lang), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return lang === "fr" ? `${n} ${sym}` : `${sym}${n}`;
}

export function CostQuotas() {
  const t = useT();
  const { lang } = useLang();
  const locale = useLocale();
  const navigate = useNavigate();
  const cost = useResource(useCallback(() => Api.cost(), []));
  const c = cost.data;

  // Horodatage du relevé : la fenêtre est GLISSANTE (24 h) et la page ne se rafraîchit
  // qu'à la demande — sans cette date, l'écran vieillit en silence. Pas d'auto-refresh :
  // ce serait du polling client permanent sur une console d'admin.
  const [readAt, setReadAt] = useState<Date | null>(null);
  useEffect(() => {
    if (c) setReadAt(new Date());
  }, [c]);

  const noCap = c != null && c.cost_cap_eur_per_day === 0;
  // Aucun appel journalisé : installation neuve ou purge de rétention — ce n'est pas une panne.
  const empty = c != null && c.llm_calls_total === 0;
  // Pourcentage borné visuellement à 0–100 pour la barre (la valeur réelle peut dépasser).
  const pct = c?.pct_of_cap ?? 0;
  const pctClamped = Math.min(100, Math.max(0, pct));
  // Couleur : rouge si plafond atteint, ambre ≥ 70 %, vert sinon.
  const barColor = c?.over_cap ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-success";

  const capButton = (
    <Button variant="outline" size="sm" onClick={() => navigate("/engine/guardrails")}>
      <Settings />
      {t("Relever le plafond", "Raise the cap")}
    </Button>
  );

  return (
    <div className="space-y-4">
      {/* En-tête — le <h1> de la route est rendu par le Layout, ne pas le doubler. */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="text-body text-muted-foreground">
          {t(
            "Dépense LLM des dernières 24 h et plafond journalier glissant.",
            "LLM spend over the last 24h and the rolling daily cap.",
          )}
        </p>
        <div className="flex items-center gap-2">
          {readAt && (
            <span className="text-caption text-muted-foreground">
              {t("Relevé à", "Read at")}{" "}
              {readAt.toLocaleTimeString(locale, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={cost.reload}
            disabled={cost.loading}
            title={t(
              "Fenêtre glissante de 24 h : la valeur affichée vieillit.",
              "Rolling 24h window: the displayed value ages.",
            )}
          >
            <RefreshCw className={cn(cost.loading && "animate-spin")} />
            {t("Actualiser", "Refresh")}
          </Button>
        </div>
      </div>

      {cost.error ? (
        <Banner kind="error">
          {t("Erreur de chargement", "Failed to load")} : {cost.error}
        </Banner>
      ) : null}

      {/* Bannière plafond atteint — calque le comportement du moteur (cost_cap). L'action
          utile (relever le plafond) est DANS la bannière : la reléguer en bas de page la
          plaçait hors du champ visuel au moment précis où elle sert. */}
      {c?.over_cap ? (
        <Banner kind="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {t(
                "⚠ Plafond de coût journalier atteint : les appels LLM facturables sont en pause. Les nouveaux tickets partent « à trier » jusqu'à la reprise (fenêtre glissante de 24 h ou plafond relevé).",
                "⚠ Daily cost cap reached: billable LLM calls are paused. New tickets go « to triage » until it resumes (rolling 24h window or a raised cap).",
              )}
            </span>
            {capButton}
          </div>
        </Banner>
      ) : null}

      {/* Absence de plafond : ce n'est pas une information neutre, c'est le seul garde-fou
          qui empêche une facture LLM de filer. */}
      {noCap ? (
        <Banner kind="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {t(
                "⚠ Aucun plafond de coût : la dépense LLM n'est bornée par rien. Un afflux de tickets ou un modèle cher se facture sans que le moteur ne s'arrête.",
                "⚠ No cost cap: LLM spend is bounded by nothing. A ticket surge or an expensive model bills on without the engine ever stopping.",
              )}
            </span>
            <Button variant="outline" size="sm" onClick={() => navigate("/engine/guardrails")}>
              <Settings />
              {t("Définir un plafond", "Set a cap")}
            </Button>
          </div>
        </Banner>
      ) : null}

      {/* Chargement : squelette plutôt que « — », qui se confond avec « aucun appel ». */}
      {cost.loading && !c ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <KpiSkeleton data-testid="cost-skeleton" />
          <KpiSkeleton data-testid="cost-skeleton" />
          <KpiSkeleton data-testid="cost-skeleton" />
        </div>
      ) : empty ? (
        <Card>
          <EmptyState
            icon={Wallet}
            title={t("Aucun appel LLM enregistré", "No LLM call recorded")}
            description={t(
              "Le moteur n'a encore facturé aucun appel : polling arrêté, aucun ticket entré dans le périmètre, ou journal purgé. La dépense apparaîtra ici dès le premier appel.",
              "The engine has not billed a single call yet: polling stopped, no ticket entered the scope, or the journal was purged. Spend will show up here on the first call.",
            )}
            action={
              <Button variant="outline" size="sm" onClick={() => navigate("/engine/ingestion")}>
                <Settings />
                {t("Vérifier l'ingestion", "Check ingestion")}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
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
              value={c ? c.llm_calls_total.toLocaleString(locale) : "—"}
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
              <CardContent className="flex flex-col gap-2">
                {/* Jauge accessible : rôle progressbar + valeurs ARIA (la valeur réelle, non bornée,
                    est annoncée via aria-valuetext pour les dépassements > 100 %). */}
                {/* NB : progressbar est un rôle ARIA NON interactif (WAI-ARIA APG) — il ne doit pas
                    être focusable, donc pas de tabIndex. (La suppression `useFocusableInteractive`
                    n'est plus nécessaire depuis Biome 2, qui ne signale plus ce faux positif.) */}
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
                <div className="flex items-center justify-between text-body text-muted-foreground">
                  <span>{formatMoney(c.spent_eur_last_24h, c.currency, lang)}</span>
                  <span>{formatMoney(c.cost_cap_eur_per_day, c.currency, lang)}</span>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}

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
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <div className="text-caption text-muted-foreground">{t("Entrée", "Input")}</div>
              <div className="mt-1 text-metric font-semibold tracking-tight">
                {formatMoney(c.price_input_per_mtok, c.currency, lang)}{" "}
                <span className="text-body font-normal text-muted-foreground">
                  {t("/ Mtok entrée", "/ Mtok input")}
                </span>
              </div>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <div className="text-caption text-muted-foreground">{t("Sortie", "Output")}</div>
              <div className="mt-1 text-metric font-semibold tracking-tight">
                {formatMoney(c.price_output_per_mtok, c.currency, lang)}{" "}
                <span className="text-body font-normal text-muted-foreground">
                  {t("/ Mtok sortie", "/ Mtok output")}
                </span>
              </div>
            </div>
            <p className="text-caption text-muted-foreground sm:col-span-2">
              {t(
                "Ces tarifs sont des estimations indicatives : la facturation réelle dépend du fournisseur LLM.",
                "These tariffs are indicative estimates: real billing depends on the LLM provider.",
              )}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* Renvoi vers l'écran qui PORTE le plafond — « Moteur » désignait une page de dix-sept
          réglages où il fallait encore le chercher. Cette page-ci reste en lecture seule. */}
      <Card>
        <CardContent className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-body text-muted-foreground">
            {t(
              "Le plafond de coût et les tarifs se règlent dans Moteur › Garde-fous. Cette page est en lecture seule.",
              "The cost cap and tariffs are set in Engine › Guardrails. This page is read-only.",
            )}
          </p>
          <Button variant="outline" onClick={() => navigate("/engine/guardrails")}>
            <Settings />
            {t("Régler le plafond", "Set the cap")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
