import { useCallback, useEffect, useState } from "react";
import { Banner, PageHeader } from "@/components/PageHeader";
import { SyncButton } from "@/components/SyncButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useResource } from "@/hooks/useResource";
import { Api, type EligibilityItem, type RefItem, type RefKind } from "@/lib/api";

/**
 * Éditeur générique d'éligibilité (techniciens / groupes) : on scanne GLPI, puis on
 * coche qui est éligible et on décrit ses compétences (prose) pour le routage.
 */
export function RefEligibilityEditor({
  kind,
  title,
  description,
  save,
}: {
  kind: RefKind;
  title: string;
  description: string;
  save: (items: EligibilityItem[]) => Promise<RefItem[]>;
}) {
  const res = useResource(useCallback(() => Api.discovery(kind), [kind]));
  const [draft, setDraft] = useState<Record<number, { eligible: boolean; skills: string }>>({});
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  // Initialise le brouillon dès que les données arrivent.
  useEffect(() => {
    if (res.data) {
      setDraft(
        Object.fromEntries(res.data.map((r) => [r.ext_id, { eligible: r.eligible, skills: r.skills }])),
      );
    }
  }, [res.data]);

  function patch(id: number, p: Partial<{ eligible: boolean; skills: string }>) {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...p } }));
  }

  async function onSave() {
    setMsg(null);
    try {
      await save(Object.entries(draft).map(([ext_id, v]) => ({ ext_id: Number(ext_id), ...v })));
      res.reload();
      setMsg({ kind: "success", text: "Enregistré." });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={<SyncButton onSynced={res.reload} />}
      />
      {msg && (
        <div className="mb-4">
          <Banner kind={msg.kind}>{msg.text}</Banner>
        </div>
      )}

      {res.data?.length === 0 && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Aucun élément. Cliquez sur « Scanner GLPI » pour récupérer la liste depuis votre instance.
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {res.data?.map((r) => {
          const d = draft[r.ext_id] ?? { eligible: r.eligible, skills: r.skills };
          return (
            <Card key={r.ext_id}>
              <CardContent className="p-4">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={d.eligible}
                    onChange={(e) => patch(r.ext_id, { eligible: e.target.checked })}
                  />
                  <span className="font-medium">
                    {r.name} <span className="text-muted-foreground">#{r.ext_id}</span>
                  </span>
                </label>
                {d.eligible && (
                  <Textarea
                    className="mt-3"
                    value={d.skills}
                    placeholder="Compétences / domaines (prose) — sert au routage de l'IA…"
                    onChange={(e) => patch(r.ext_id, { skills: e.target.value })}
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {res.data && res.data.length > 0 && (
        <div className="mt-4">
          <Button onClick={onSave}>Enregistrer la sélection</Button>
        </div>
      )}
    </>
  );
}
