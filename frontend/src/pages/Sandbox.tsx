import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Api, type SandboxResult } from "@/lib/api";

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
        title="Sandbox"
        description="Triage à blanc d'un texte de ticket — n'écrit RIEN dans GLPI. Idéal pour tester/calibrer."
      />
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          <Textarea
            rows={5}
            value={text}
            placeholder="Collez le texte d'un ticket (ex. « slt jarrive plus à me connecter, mdp refusé »)…"
            onChange={(e) => setText(e.target.value)}
          />
          <div>
            <Button onClick={run} disabled={busy || !text.trim()}>
              {busy ? "Analyse…" : "Tester la suggestion"}
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {result && (
            <div className="rounded-md border border-border bg-muted/40 p-4">
              <div className="mb-3 flex items-center gap-2">
                {result.accepted ? (
                  <Badge variant="success">déposable</Badge>
                ) : (
                  <Badge variant="warn">à trier — {result.reason}</Badge>
                )}
                {result.confidence != null && (
                  <span className="text-sm text-muted-foreground">
                    confiance {Math.round(result.confidence * 100)}%
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Catégorie</span>
                  <p className="font-medium">{result.category ?? "—"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Priorité</span>
                  <p className="font-medium">{result.priority ?? "—"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Technicien</span>
                  <p className="font-medium">{result.technician_id ?? "—"}</p>
                </div>
              </div>
              {result.draft && (
                <div className="mt-3">
                  <span className="text-sm text-muted-foreground">Brouillon de réponse</span>
                  <p className="mt-1 whitespace-pre-wrap rounded bg-card p-3 text-sm">{result.draft}</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
