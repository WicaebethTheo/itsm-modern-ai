import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { Api, type SandboxResult } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { confidenceTone, priorityLabel, priorityTone } from "@/lib/labels";
import { FlaskConical } from "lucide-react";
import { type ReactNode, useState } from "react";

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-[12.5px]" : "text-[12.5px] font-medium"}>
        {value}
      </span>
    </div>
  );
}

export function Sandbox() {
  const t = useT();
  const [text, setText] = useState("");
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setError("");
    setResult(null);
    setBusy(true);
    try {
      setResult(await Api.sandbox(text));
    } catch (e: unknown) {
      // ApiError porte déjà le message backend (detail.message) ou un libellé par status.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Ticket de test */}
      <Card>
        <PanelHead
          title={t("Ticket de test", "Test ticket")}
          subtitle={t(
            "Le texte n'est jamais déposé dans GLPI",
            "The text is never written to GLPI",
          )}
        />
        <CardContent className="flex flex-col gap-4 p-5">
          <Textarea
            rows={8}
            value={text}
            placeholder={t(
              "Collez le texte d'un ticket (ex. « slt jarrive plus à me connecter, mdp refusé »)…",
              "Paste a ticket's text (e.g. “hi I can't log in anymore, password rejected”)…",
            )}
            onChange={(e) => setText(e.target.value)}
          />
          <div>
            <Button onClick={run} disabled={busy || !text.trim()}>
              {busy ? t("Analyse…", "Analyzing…") : t("Simuler la décision", "Simulate decision")}
            </Button>
          </div>
          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {/* Décision simulée */}
      <Card>
        <PanelHead
          title={t("Décision simulée", "Simulated decision")}
          right={
            result ? (
              result.accepted ? (
                <Tag tone="green">{t("déposable", "depositable")}</Tag>
              ) : (
                <Tag tone="amber">{t("à trier", "to triage")}</Tag>
              )
            ) : undefined
          }
        />
        <CardContent className="p-5">
          {result ? (
            <>
              <div className="flex flex-col">
                <Row
                  label={t("Routage — catégorie", "Routing — category")}
                  value={
                    result.category_name
                      ? `${result.category_name} (#${result.category})`
                      : (result.category ?? "—")
                  }
                />
                <Row
                  label={t("Priorité", "Priority")}
                  value={
                    result.priority != null ? (
                      <Tag tone={priorityTone(result.priority)}>
                        {priorityLabel(result.priority, t)}
                      </Tag>
                    ) : (
                      "—"
                    )
                  }
                />
                <Row
                  label={t("Routage — technicien / groupe", "Routing — technician / group")}
                  value={
                    result.technician_id != null
                      ? result.technician_name
                        ? `${result.technician_name} (#${result.technician_id})`
                        : `T#${result.technician_id}`
                      : result.group_id != null
                        ? result.group_name
                          ? `${result.group_name} (#${result.group_id})`
                          : `G#${result.group_id}`
                        : "—"
                  }
                />
                <Row
                  label={t("Confiance", "Confidence")}
                  value={
                    result.confidence != null ? (
                      <Tag tone={confidenceTone(result.confidence)}>
                        {Math.round(result.confidence * 100)}%
                      </Tag>
                    ) : (
                      "—"
                    )
                  }
                />
                <Row
                  label={t("Validation liste blanche", "Whitelist validation")}
                  value={
                    result.accepted ? (
                      <Tag tone="green">OK</Tag>
                    ) : (
                      <Tag tone="amber">{result.reason ?? t("à trier", "to triage")}</Tag>
                    )
                  }
                />
              </div>
              {result.draft && (
                <div className="mt-4">
                  <p className="mb-1.5 text-[11px] text-muted-foreground">
                    {t("Brouillon de réponse (draft)", "Draft reply (draft)")}
                  </p>
                  <p className="whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-[12.5px] leading-relaxed">
                    {result.draft}
                  </p>
                </div>
              )}
            </>
          ) : (
            <EmptyState
              icon={FlaskConical}
              title={t("Aucune simulation", "No simulation")}
              description={t(
                "Saisissez un ticket à gauche puis lancez la simulation.",
                "Enter a ticket on the left, then run the simulation.",
              )}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
