import { RefreshCw, ScrollText, Search, SearchX } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Banner } from "@/components/Banner";
import { EmptyState } from "@/components/EmptyState";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, DEMO, type DecisionEntry } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n";
import { confidenceTone, priorityLabel, priorityTone, reasonLabel, reasonTone } from "@/lib/labels";
import { cn } from "@/lib/utils";

/** Pas de chargement — aligné sur `DEFAULT_DECISIONS_LIMIT` (persistence/journal.py). */
const PAGE = 500;
/** Plafond serveur (`le=10_000` sur /api/decisions) : au-delà, la requête serait rejetée. */
const MAX_LIMIT = 10_000;

function AnnotationCell({ d, ph }: { d: DecisionEntry; ph: string }) {
  const t = useT();
  const toast = useToast();
  const [value, setValue] = useState(d.annotation);
  const [saved, setSaved] = useState<"idle" | "ok">("idle");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        placeholder={ph}
        className="h-8 min-w-40"
        // Sans nom explicite, cinq cents champs s'annoncent « zone de texte » à
        // l'identique : le lecteur d'écran ne dit pas de quel ticket il s'agit.
        aria-label={t(
          `Annotation du ticket #${d.ticket_id}`,
          `Annotation for ticket #${d.ticket_id}`,
        )}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved("idle");
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        aria-label={t(
          `Enregistrer l'annotation du ticket #${d.ticket_id}`,
          `Save annotation for ticket #${d.ticket_id}`,
        )}
        onClick={async () => {
          setBusy(true);
          try {
            await Api.annotate(d.id, value);
            setSaved("ok");
            toast.success(t("Annotation enregistrée.", "Annotation saved."));
          } catch (e) {
            toast.error((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        OK
      </Button>
      {/* Confirmation ANNONCÉE : le ✓ qui remplaçait le libellé du bouton n'était vu
          que des voyants (et faisait disparaître le nom accessible du bouton).
          La région existe en permanence, sinon rien n'est annoncé à la mise à jour. */}
      <span role="status" className="text-caption text-success">
        {saved === "ok" ? t("enregistrée", "saved") : ""}
      </span>
    </div>
  );
}

export function Journal() {
  const t = useT();
  const locale = useLocale();
  // `limit` fait partie des dépendances du fetcher : sans ça, « En charger davantage »
  // changerait l'état sans jamais relancer la requête.
  const [limit, setLimit] = useState(PAGE);
  const decisions = useResource(useCallback(() => Api.decisions(limit), [limit]));
  const [query, setQuery] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);

  const rows = decisions.data ?? [];
  const pendingCount = rows.filter((d) => !d.accepted).length;

  // Filtre 100 % LOCAL : les lignes sont déjà en mémoire, aucun aller-retour serveur
  // (le backend n'offre d'ailleurs aucun filtre). La recherche porte sur le motif
  // TRADUIT : on cherche ce qu'on lit à l'écran, pas la clé anglaise du moteur.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((d) => {
      if (pendingOnly && d.accepted) return false;
      if (!q) return true;
      return `#${d.ticket_id} ${d.subject} ${reasonLabel(d.reason, t)}`.toLowerCase().includes(q);
    });
  }, [rows, query, pendingOnly, t]);

  const truncated = !decisions.loading && !decisions.error && rows.length === limit;

  return (
    <Card className="overflow-hidden">
      <PanelHead
        title={t("Journal des décisions", "Decision journal")}
        subtitle={
          decisions.data
            ? t(
                `${filtered.length}/${rows.length} affichée(s) · ${pendingCount} à trier`,
                `${filtered.length}/${rows.length} shown · ${pendingCount} to triage`,
              )
            : undefined
        }
        right={
          <>
            {/* Page qu'on garde ouverte pendant que le poller tourne : le rafraîchissement
                doit être à portée de clic, sans recharger toute la console. */}
            <Button
              size="sm"
              variant="outline"
              disabled={decisions.loading}
              onClick={decisions.reload}
            >
              <RefreshCw
                aria-hidden
                className={cn("h-3.5 w-3.5", decisions.loading && "animate-spin")}
              />
              {t("Rafraîchir", "Refresh")}
            </Button>
            {/* En démo, les exports CSV pointent vers un backend absent (405) → masqués. */}
            {!DEMO && (
              <>
                {/* Ancre stylée en bouton (pas de <button> dans <a> : HTML invalide). */}
                <a
                  href="/api/export/decisions.csv"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {t("Export décisions", "Export decisions")}
                </a>
                <a
                  href="/api/export/llm-calls.csv"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {t("Export appels LLM", "Export LLM calls")}
                </a>
              </>
            )}
          </>
        }
      />

      {/* Chargement / erreur / vide / contenu : EXCLUSIFS. Un <table> monté à vide ne
          montre que ses en-têtes — indiscernable d'un journal vide. */}
      {decisions.loading ? (
        <p className="p-6 text-body text-muted-foreground">{t("Chargement…", "Loading…")}</p>
      ) : decisions.error ? (
        <div className="p-5">
          <Banner kind="error" role="alert">
            {decisions.error}
          </Banner>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={t("Aucune décision pour le moment", "No decisions yet")}
          description={t(
            "Les tickets traités et les « à trier » s'afficheront ici.",
            "Handled tickets and “to triage” entries will appear here.",
          )}
        />
      ) : (
        <>
          {/* Barre d'outils (même conteneur que RefEligibilityEditor). */}
          <div className="flex flex-wrap items-center gap-2.5 border-b border-border bg-muted/30 px-5 py-3">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                placeholder={t(
                  "Rechercher un n° de ticket, un sujet, un motif…",
                  "Search a ticket no., subject, reason…",
                )}
                aria-label={t("Rechercher dans le journal", "Search the journal")}
                className="pl-9"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex h-9 items-center rounded-md border border-input bg-card px-3">
              <Toggle
                checked={pendingOnly}
                onChange={setPendingOnly}
                label={t("À trier seulement", "To triage only")}
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              dense
              icon={SearchX}
              title={t("Aucun résultat pour ce filtre.", "No result for this filter.")}
            />
          ) : (
            // 7 colonnes dont une porte un champ + un bouton : sous ~1100 px la dernière
            // sortait du cadre d'une Card `overflow-hidden`, sans barre de défilement.
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-body">
                <caption className="sr-only">
                  {t(
                    "Journal des décisions de triage : date, ticket, sujet, statut, routage, confiance et annotation.",
                    "Triage decision journal: date, ticket, subject, status, routing, confidence and annotation.",
                  )}
                </caption>
                <thead className="border-b border-border bg-muted/30 text-caption font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-5 py-2 text-left font-medium">
                      Date
                    </th>
                    <th scope="col" className="px-5 py-2 text-left font-medium">
                      Ticket
                    </th>
                    <th scope="col" className="px-5 py-2 text-left font-medium">
                      {t("Sujet", "Subject")}
                    </th>
                    <th scope="col" className="px-5 py-2 text-left font-medium">
                      {t("Statut", "Status")}
                    </th>
                    <th scope="col" className="px-5 py-2 text-left font-medium">
                      {t("Routage · cat./urg./prio.", "Routing · cat./urg./prio.")}
                    </th>
                    <th scope="col" className="px-5 py-2 text-left font-medium">
                      {t("Conf.", "Conf.")}
                    </th>
                    <th scope="col" className="px-5 py-2 text-left font-medium">
                      {t("Annotation", "Annotation")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr
                      key={d.id}
                      className={cn(
                        "border-t border-border",
                        // Ce qui réclame l'attention se voit AVANT d'être lu : teinte + rail
                        // gauche, en alpha pour rester lisibles en thème clair et sombre.
                        // Rouge = le moteur est empêché ; ambre = un garde-fou a joué.
                        !d.accepted &&
                          (reasonTone(d.reason) === "red"
                            ? "border-l-2 border-l-destructive/70 bg-destructive/[0.05]"
                            : "border-l-2 border-l-warning/70 bg-warning/[0.05]"),
                      )}
                    >
                      <td className="whitespace-nowrap px-5 py-2 tabular-nums text-muted-foreground">
                        {new Date(d.ts).toLocaleString(locale, {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </td>
                      <td className="px-5 py-2">
                        {d.glpi_link ? (
                          <a
                            className="font-mono text-primary hover:underline"
                            href={d.glpi_link}
                            target="_blank"
                            rel="noreferrer"
                            title={t(
                              "Ouvrir le ticket dans GLPI (nouvel onglet)",
                              "Open the ticket in GLPI (new tab)",
                            )}
                          >
                            #{d.ticket_id}
                          </a>
                        ) : (
                          <span className="font-mono">#{d.ticket_id}</span>
                        )}
                      </td>
                      <td className="px-5 py-2">
                        <div className="max-w-[280px] truncate" title={d.subject || undefined}>
                          {d.subject ? (
                            d.glpi_link ? (
                              <a
                                className="text-primary hover:underline"
                                href={d.glpi_link}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {d.subject}
                              </a>
                            ) : (
                              d.subject
                            )
                          ) : (
                            "—"
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-2">
                        {d.accepted ? (
                          <Tag tone="green">{t("traité", "handled")}</Tag>
                        ) : (
                          <Tag tone={reasonTone(d.reason)}>{reasonLabel(d.reason, t)}</Tag>
                        )}
                        {/* Un « à trier » repris par le repli et un « à trier » orphelin
                            n'ont pas la même suite : le second seul réclame une main.
                            `undefined` = moteur antérieur, on ne prétend pas savoir. */}
                        {!d.accepted && d.fallback_applied !== undefined && (
                          <div className="mt-1 text-caption text-muted-foreground">
                            {d.fallback_applied
                              ? t("repli assigné", "fallback assigned")
                              : t("aucun destinataire", "no assignee")}
                          </div>
                        )}
                        {d.mode && (
                          <div className="mt-1 text-caption text-muted-foreground">
                            {d.mode === "full_auto"
                              ? "full-auto"
                              : d.mode === "semi_auto"
                                ? "semi-auto"
                                : t("suggestion", "suggestion")}
                            {d.applied
                              ? ` · ${t("appliqué", "applied")}`
                              : ` · ${t("proposé", "proposed")}`}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-2">
                        <div className="font-medium">
                          {d.technician_name ??
                            d.group_name ??
                            (d.technician_id != null
                              ? `T#${d.technician_id}`
                              : d.group_id != null
                                ? `G#${d.group_id}`
                                : "—")}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
                          <span>
                            {d.category_name ?? (d.category != null ? `#${d.category}` : "—")}
                          </span>
                          <span>·</span>
                          <span>
                            {t("urg.", "urg.")} {d.urgency ?? "—"}
                          </span>
                          <span>·</span>
                          {d.priority != null ? (
                            <Tag tone={priorityTone(d.priority)}>
                              {priorityLabel(d.priority, t)}
                            </Tag>
                          ) : (
                            <span>{t("prio.", "prio.")} —</span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-2">
                        {d.confidence != null ? (
                          <Tag tone={confidenceTone(d.confidence)}>
                            {Math.round(d.confidence * 100)}%
                          </Tag>
                        ) : (
                          <span className="font-mono">—</span>
                        )}
                      </td>
                      <td className="px-5 py-2">
                        {/* key sur id+annotation : l'état local (useState initialisé une seule
                            fois) est réinitialisé si l'annotation serveur change après reload. */}
                        <AnnotationCell
                          key={`${d.id}:${d.annotation}`}
                          d={d}
                          ph={t("juste / faux / signal…", "right / wrong / signal…")}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Le plafond doit se DIRE : « 500 décision(s) » laissait croire qu'on voyait
          tout le journal alors qu'on n'en voit que la queue. */}
      {truncated && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-caption text-muted-foreground">
          <span>
            {t(
              `Seules les ${limit} décisions les plus récentes sont affichées.`,
              `Only the ${limit} most recent decisions are shown.`,
            )}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={limit >= MAX_LIMIT}
            onClick={() => setLimit((n) => Math.min(n + PAGE, MAX_LIMIT))}
          >
            {limit >= MAX_LIMIT
              ? t("Maximum atteint", "Maximum reached")
              : t("En charger davantage", "Load more")}
          </Button>
        </div>
      )}
    </Card>
  );
}
