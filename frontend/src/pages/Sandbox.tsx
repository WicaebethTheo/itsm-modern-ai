import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { Api, type SandboxResult } from "@/lib/api";
import { FlaskConical } from "lucide-react";
import { useState } from "react";

function KV({ label, value, mono }: { label: string; value: string | number; mono?: boolean }) {
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
      const payload = (e as { payload?: { detail?: { message?: string } } }).payload;
      setError(payload?.detail?.message ?? (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Bac à sable"
        description="Triage à blanc d'un texte de ticket — n'écrit RIEN dans GLPI. Idéal pour tester/calibrer."
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Panneau gauche : ticket de test */}
        <Card>
          <PanelHead title="Ticket de test" subtitle="Le texte n'est jamais déposé dans GLPI" />
          <CardContent className="flex flex-col gap-4 p-5">
            <Textarea
              rows={8}
              value={text}
              placeholder="Collez le texte d'un ticket (ex. « slt jarrive plus à me connecter, mdp refusé »)…"
              onChange={(e) => setText(e.target.value)}
            />
            <div>
              <Button onClick={run} disabled={busy || !text.trim()}>
                {busy ? "Analyse…" : "Simuler la décision"}
              </Button>
            </div>
            {error && <p className="text-[12.5px] text-destructive">{error}</p>}
          </CardContent>
        </Card>

        {/* Panneau droit : décision simulée */}
        <Card>
          <PanelHead
            title="Décision simulée"
            right={
              result ? (
                result.accepted ? (
                  <Tag tone="green">déposable</Tag>
                ) : (
                  <Tag tone="amber">à trier</Tag>
                )
              ) : undefined
            }
          />
          <CardContent className="p-5">
            {result ? (
              <>
                <div className="flex flex-col">
                  <KV label="Routage — catégorie" value={result.category ?? "—"} />
                  <KV label="Priorité" value={result.priority ?? "—"} />
                  <KV
                    label="Technicien"
                    value={result.technician_id != null ? `T#${result.technician_id}` : "—"}
                    mono
                  />
                  <KV
                    label="Confiance"
                    value={
                      result.confidence != null ? `${Math.round(result.confidence * 100)}%` : "—"
                    }
                    mono
                  />
                  <KV
                    label="Validation"
                    value={
                      result.accepted ? "OK (whitelist + seuil)" : (result.reason ?? "à trier")
                    }
                  />
                </div>
                {result.draft && (
                  <div className="mt-4">
                    <p className="mb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                      Brouillon de réponse (draft_reply)
                    </p>
                    <p className="whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-[12.5px]">
                      {result.draft}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <EmptyState
                icon={FlaskConical}
                title="Aucune simulation"
                description="Saisissez un ticket à gauche puis lancez la simulation."
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
