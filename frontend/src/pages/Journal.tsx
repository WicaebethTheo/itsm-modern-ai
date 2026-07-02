import { EmptyState } from "@/components/EmptyState";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api, DEMO, type DecisionEntry } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { confidenceTone, priorityLabel, priorityTone } from "@/lib/labels";
import { ScrollText } from "lucide-react";
import { useCallback, useState } from "react";

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
        className="h-8"
        onChange={(e) => {
          setValue(e.target.value);
          setSaved("idle");
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
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
        {saved === "ok" ? "✓" : "OK"}
      </Button>
    </div>
  );
}

export function Journal() {
  const t = useT();
  const decisions = useResource(useCallback(() => Api.decisions(), []));

  return (
    <Card className="overflow-hidden">
      <PanelHead
        title={t("Journal des décisions", "Decision journal")}
        subtitle={
          decisions.data
            ? t(`${decisions.data.length} décision(s)`, `${decisions.data.length} decision(s)`)
            : undefined
        }
        right={
          // En démo, les exports CSV pointent vers un backend absent (405) → masqués.
          DEMO ? undefined : (
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
          )
        }
      />
      <table className="w-full text-[12.5px]">
        <thead className="border-b border-border bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Date</th>
            <th className="px-4 py-2 text-left font-medium">Ticket</th>
            <th className="px-4 py-2 text-left font-medium">{t("Sujet", "Subject")}</th>
            <th className="px-4 py-2 text-left font-medium">{t("Statut", "Status")}</th>
            <th className="px-4 py-2 text-left font-medium">
              {t("Routage · cat./urg./prio.", "Routing · cat./urg./prio.")}
            </th>
            <th className="px-4 py-2 text-left font-medium">{t("Conf.", "Conf.")}</th>
            <th className="px-4 py-2 text-left font-medium">{t("Annotation", "Annotation")}</th>
          </tr>
        </thead>
        <tbody>
          {decisions.data?.map((d) => (
            <tr key={d.id} className="border-t border-border">
              <td className="px-4 py-2 text-muted-foreground">
                {new Date(d.ts).toLocaleString(t("fr-FR", "en-US"), {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </td>
              <td className="px-4 py-2">
                {d.glpi_link ? (
                  <a
                    className="font-mono text-primary hover:underline"
                    href={d.glpi_link}
                    target="_blank"
                    rel="noreferrer"
                  >
                    #{d.ticket_id}
                  </a>
                ) : (
                  <span className="font-mono">#{d.ticket_id}</span>
                )}
              </td>
              <td className="px-4 py-2">
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
              <td className="px-4 py-2">
                {d.accepted ? (
                  <Tag tone="green">{t("traité", "handled")}</Tag>
                ) : (
                  <Tag tone="amber">{d.reason}</Tag>
                )}
                {d.mode && (
                  <div className="mt-1 text-[10.5px] text-muted-foreground">
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
              <td className="px-4 py-2">
                <div className="font-medium">
                  {d.technician_name ??
                    d.group_name ??
                    (d.technician_id != null
                      ? `T#${d.technician_id}`
                      : d.group_id != null
                        ? `G#${d.group_id}`
                        : "—")}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{d.category_name ?? (d.category != null ? `#${d.category}` : "—")}</span>
                  <span>·</span>
                  <span>
                    {t("urg.", "urg.")} {d.urgency ?? "—"}
                  </span>
                  <span>·</span>
                  {d.priority != null ? (
                    <Tag tone={priorityTone(d.priority)}>{priorityLabel(d.priority, t)}</Tag>
                  ) : (
                    <span>{t("prio.", "prio.")} —</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-2">
                {d.confidence != null ? (
                  <Tag tone={confidenceTone(d.confidence)}>{Math.round(d.confidence * 100)}%</Tag>
                ) : (
                  <span className="font-mono">—</span>
                )}
              </td>
              <td className="px-4 py-2">
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
      {decisions.data?.length === 0 && (
        <EmptyState
          icon={ScrollText}
          title={t("Aucune décision pour le moment", "No decisions yet")}
          description={t(
            "Les tickets traités et les « à trier » s'afficheront ici.",
            "Handled tickets and “to triage” entries will appear here.",
          )}
        />
      )}
      {decisions.error && <p className="p-6 text-[12.5px] text-destructive">{decisions.error}</p>}
    </Card>
  );
}
