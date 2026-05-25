import { useCallback, useEffect, useState } from "react";
import { Banner, PageHeader } from "@/components/PageHeader";
import { SyncButton } from "@/components/SyncButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useResource } from "@/hooks/useResource";
import { Api, type RefItem } from "@/lib/api";

function CheckList({
  items,
  selected,
  onToggle,
  empty,
}: {
  items: RefItem[];
  selected: Set<number>;
  onToggle: (id: number, on: boolean) => void;
  empty: string;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="flex max-h-80 flex-col gap-1.5 overflow-auto">
      {items.map((it) => (
        <label key={it.ext_id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={selected.has(it.ext_id)}
            onChange={(e) => onToggle(it.ext_id, e.target.checked)}
          />
          {it.name} <span className="text-muted-foreground">#{it.ext_id}</span>
        </label>
      ))}
    </div>
  );
}

export function Scope() {
  const categories = useResource(useCallback(() => Api.discovery("category"), []));
  const entities = useResource(useCallback(() => Api.discovery("entity"), []));
  const [cats, setCats] = useState<Set<number>>(new Set());
  const [ents, setEnts] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (categories.data) setCats(new Set(categories.data.filter((c) => c.selected).map((c) => c.ext_id)));
  }, [categories.data]);
  useEffect(() => {
    if (entities.data) setEnts(new Set(entities.data.filter((e) => e.selected).map((e) => e.ext_id)));
  }, [entities.data]);

  function toggle(set: Set<number>, setter: (s: Set<number>) => void, id: number, on: boolean) {
    const next = new Set(set);
    on ? next.add(id) : next.delete(id);
    setter(next);
  }

  async function save() {
    setMsg(null);
    try {
      await Api.setScope({ category_ids: [...cats], entity_ids: [...ents] });
      setMsg({ kind: "success", text: "Périmètre enregistré." });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  const reload = () => {
    categories.reload();
    entities.reload();
  };

  return (
    <>
      <PageHeader
        title="Périmètre"
        description="Catégories et entités que l'IA a le droit d'utiliser. Hors périmètre → « à trier »."
        actions={<SyncButton onSynced={reload} />}
      />
      {msg && (
        <div className="mb-4">
          <Banner kind={msg.kind}>{msg.text}</Banner>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Catégories autorisées</CardTitle>
          </CardHeader>
          <CardContent>
            <CheckList
              items={categories.data ?? []}
              selected={cats}
              onToggle={(id, on) => toggle(cats, setCats, id, on)}
              empty="Scannez GLPI pour lister les catégories."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Entités du périmètre</CardTitle>
          </CardHeader>
          <CardContent>
            <CheckList
              items={entities.data ?? []}
              selected={ents}
              onToggle={(id, on) => toggle(ents, setEnts, id, on)}
              empty="Scannez GLPI pour lister les entités."
            />
          </CardContent>
        </Card>
      </div>
      <div className="mt-4">
        <Button onClick={save}>Enregistrer le périmètre</Button>
      </div>
    </>
  );
}
