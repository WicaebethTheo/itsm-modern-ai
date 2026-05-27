import { Banner } from "@/components/Banner";
import { SyncButton } from "@/components/SyncButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PanelHead } from "@/components/ui/panel";
import { useResource } from "@/hooks/useResource";
import { Api, type ExecutionMode, type RefItem } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { type ReactNode, useCallback, useEffect, useState } from "react";

function CheckList({
  items,
  selected,
  onToggle,
  empty,
  trailing,
}: {
  items: RefItem[];
  selected: Set<number>;
  onToggle: (id: number, on: boolean) => void;
  empty: string;
  trailing?: (it: RefItem) => ReactNode;
}) {
  if (items.length === 0) return <p className="p-4 text-[12.5px] text-muted-foreground">{empty}</p>;
  return (
    <div className="flex max-h-80 flex-col overflow-auto">
      {items.map((it, i) => (
        <div
          key={it.ext_id}
          className={`flex items-center justify-between gap-2.5 px-4 py-2 text-[12.5px] ${i < items.length - 1 ? "border-b border-border/50" : ""}`}
        >
          <label className="flex flex-1 cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={selected.has(it.ext_id)}
              onChange={(e) => onToggle(it.ext_id, e.target.checked)}
            />
            {it.name} <span className="font-mono text-muted-foreground">#{it.ext_id}</span>
          </label>
          {trailing?.(it)}
        </div>
      ))}
    </div>
  );
}

export function Scope() {
  const t = useT();
  const categories = useResource(useCallback(() => Api.discovery("category"), []));
  const entities = useResource(useCallback(() => Api.discovery("entity"), []));
  const [cats, setCats] = useState<Set<number>>(new Set());
  const [ents, setEnts] = useState<Set<number>>(new Set());
  // Mode d'exécution par entité ("" = défaut global).
  const [modes, setModes] = useState<Map<number, ExecutionMode | "">>(new Map());
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (categories.data)
      setCats(new Set(categories.data.filter((c) => c.selected).map((c) => c.ext_id)));
  }, [categories.data]);
  useEffect(() => {
    if (entities.data) {
      setEnts(new Set(entities.data.filter((e) => e.selected).map((e) => e.ext_id)));
      setModes(new Map(entities.data.map((e) => [e.ext_id, e.mode ?? ""])));
    }
  }, [entities.data]);

  function toggle(set: Set<number>, setter: (s: Set<number>) => void, id: number, on: boolean) {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    setter(next);
  }

  function setMode(id: number, mode: ExecutionMode | "") {
    const next = new Map(modes);
    next.set(id, mode);
    setModes(next);
  }

  const hasAuto = [...modes.values()].some((m) => m === "semi_auto" || m === "full_auto");

  async function save() {
    setMsg(null);
    try {
      await Api.setScope({ category_ids: [...cats], entity_ids: [...ents] });
      await Api.saveModes([...modes].map(([ext_id, mode]) => ({ ext_id, mode: mode || null })));
      setMsg({
        kind: "success",
        text: t("Périmètre et modes enregistrés.", "Scope and modes saved."),
      });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  const reload = () => {
    categories.reload();
    entities.reload();
  };

  const MODE_OPTIONS: { value: ExecutionMode | ""; label: string }[] = [
    { value: "", label: t("Défaut global", "Global default") },
    { value: "suggestion", label: t("Suggestion", "Suggestion") },
    { value: "semi_auto", label: t("Semi-auto", "Semi-auto") },
    { value: "full_auto", label: t("Full-auto", "Full-auto") },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted-foreground">
          {t(
            "Catégories et entités que l'IA a le droit d'utiliser. Hors périmètre → « à trier ».",
            "Categories and entities the AI may use. Out of scope → “to triage”.",
          )}
        </p>
        <SyncButton onSynced={reload} />
      </div>
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      {hasAuto && (
        <Banner kind="error">
          {t(
            "⚠ Mode semi/full-auto : l'IA modifiera réellement les champs des tickets GLPI (catégorie, priorité, assignation) des entités concernées — après le garde-fou. À activer en connaissance de cause.",
            "⚠ Semi/full-auto mode: the AI will actually modify GLPI ticket fields (category, priority, assignment) for those entities — after the guardrail. Enable deliberately.",
          )}
        </Banner>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="overflow-hidden">
          <PanelHead
            title={t("Catégories autorisées", "Allowed categories")}
            subtitle={`${cats.size} ${t("sélectionnée(s)", "selected")}`}
          />
          <CheckList
            items={categories.data ?? []}
            selected={cats}
            onToggle={(id, on) => toggle(cats, setCats, id, on)}
            empty={t("Scannez GLPI pour lister les catégories.", "Scan GLPI to list categories.")}
          />
        </Card>
        <Card className="overflow-hidden">
          <PanelHead
            title={t("Entités du périmètre", "Scope entities")}
            subtitle={`${ents.size} ${t("sélectionnée(s)", "selected")} · ${t("mode par entité", "mode per entity")}`}
          />
          <CheckList
            items={entities.data ?? []}
            selected={ents}
            onToggle={(id, on) => toggle(ents, setEnts, id, on)}
            empty={t("Scannez GLPI pour lister les entités.", "Scan GLPI to list entities.")}
            trailing={(it) => (
              <select
                className="rounded border border-border bg-transparent px-1.5 py-0.5 text-[11px]"
                value={modes.get(it.ext_id) ?? ""}
                onChange={(e) => setMode(it.ext_id, e.target.value as ExecutionMode | "")}
              >
                {MODE_OPTIONS.map((o) => (
                  <option key={o.value || "default"} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          />
        </Card>
      </div>
      <Button onClick={save}>
        {t("Enregistrer le périmètre et les modes", "Save scope and modes")}
      </Button>
    </div>
  );
}
