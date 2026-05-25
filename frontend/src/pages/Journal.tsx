import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useResource } from "@/hooks/useResource";
import { Api, type DecisionEntry } from "@/lib/api";
import { ScrollText } from "lucide-react";
import { useCallback, useState } from "react";

function AnnotationCell({ d }: { d: DecisionEntry }) {
  const [value, setValue] = useState(d.annotation);
  const [saved, setSaved] = useState<"idle" | "ok">("idle");
  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        placeholder="juste / faux / signal…"
        className="h-8"
        onChange={(e) => {
          setValue(e.target.value);
          setSaved("idle");
        }}
      />
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          await Api.annotate(d.id, value);
          setSaved("ok");
        }}
      >
        {saved === "ok" ? "✓" : "Enregistrer"}
      </Button>
    </div>
  );
}

export function Journal() {
  const decisions = useResource(useCallback(() => Api.decisions(), []));

  return (
    <>
      <PageHeader
        title="Journal de décision"
        description="Décisions du moteur, annotables pour la revue qualité (mode suggestion)."
        actions={
          <>
            <a href="/api/export/decisions.csv">
              <Button variant="outline">Export décisions</Button>
            </a>
            <a href="/api/export/llm-calls.csv">
              <Button variant="outline">Export appels LLM</Button>
            </a>
          </>
        }
      />

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-semibold">Date</th>
              <th className="px-4 py-2.5 text-left font-semibold">Ticket</th>
              <th className="px-4 py-2.5 text-left font-semibold">Issue</th>
              <th className="px-4 py-2.5 text-left font-semibold">Cat/Prio/Affect.</th>
              <th className="px-4 py-2.5 text-left font-semibold">Conf.</th>
              <th className="px-4 py-2.5 text-left font-semibold">Annotation</th>
            </tr>
          </thead>
          <tbody>
            {decisions.data?.map((d) => (
              <tr key={d.id} className="border-t border-border">
                <td className="px-4 py-2.5 text-muted-foreground">
                  {new Date(d.ts).toLocaleString("fr-FR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </td>
                <td className="px-4 py-2.5">
                  {d.glpi_link ? (
                    <a
                      className="text-primary hover:underline"
                      href={d.glpi_link}
                      target="_blank"
                      rel="noreferrer"
                    >
                      #{d.ticket_id}
                    </a>
                  ) : (
                    `#${d.ticket_id}`
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {d.accepted ? (
                    <Badge variant="success">déposée</Badge>
                  ) : (
                    <Badge variant="warn">{d.reason}</Badge>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {d.category ?? "—"} / {d.priority ?? "—"} /{" "}
                  {d.technician_id != null
                    ? `T#${d.technician_id}`
                    : d.group_id != null
                      ? `G#${d.group_id}`
                      : "—"}
                </td>
                <td className="px-4 py-2.5">
                  {d.confidence != null ? `${Math.round(d.confidence * 100)}%` : "—"}
                </td>
                <td className="px-4 py-2.5">
                  <AnnotationCell d={d} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {decisions.data?.length === 0 && (
          <EmptyState
            icon={ScrollText}
            title="Aucune décision pour le moment"
            description="Les suggestions déposées et les « à trier » s'afficheront ici."
          />
        )}
        {decisions.error && <p className="p-6 text-sm text-destructive">{decisions.error}</p>}
      </Card>
    </>
  );
}
