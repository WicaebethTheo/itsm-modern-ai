import { Banner } from "@/components/Banner";
import { SyncButton } from "@/components/SyncButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PanelHead } from "@/components/ui/panel";
import { Tag, type TagTone } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api, type ExecutionMode, type RefItem } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckSquare, FolderTree, Layers, Save, Square } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

/** Couleur du badge de mode : neutre → amber → rouge selon l'autonomie accordée. */
const MODE_TONE: Record<ExecutionMode, TagTone> = {
  suggestion: "muted",
  semi_auto: "amber",
  full_auto: "red",
};

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
  if (items.length === 0)
    return <p className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">{empty}</p>;
  return (
    <div className="flex max-h-96 flex-col overflow-auto">
      {items.map((it, i) => {
        const on = selected.has(it.ext_id);
        return (
          <div
            key={it.ext_id}
            className={cn(
              "flex items-center justify-between gap-2.5 px-4 py-2.5 text-[12.5px] transition-colors",
              i < items.length - 1 && "border-b border-border/50",
              on ? "bg-primary/[0.04]" : "hover:bg-accent/40",
            )}
          >
            <label className="flex flex-1 cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={on}
                onChange={(e) => onToggle(it.ext_id, e.target.checked)}
              />
              <span className={cn("truncate", on ? "font-medium" : "text-muted-foreground")}>
                {it.name}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">#{it.ext_id}</span>
            </label>
            {trailing?.(it)}
          </div>
        );
      })}
    </div>
  );
}

export function Scope() {
  const t = useT();
  const toast = useToast();
  const categories = useResource(useCallback(() => Api.discovery("category"), []));
  const entities = useResource(useCallback(() => Api.discovery("entity"), []));
  const [cats, setCats] = useState<Set<number>>(new Set());
  const [ents, setEnts] = useState<Set<number>>(new Set());
  // Mode d'exécution par entité ("" = défaut global).
  const [modes, setModes] = useState<Map<number, ExecutionMode | "">>(new Map());
  // Seuil de confiance du mode semi-auto, par entité ("" = défaut global).
  const [thresholds, setThresholds] = useState<Map<number, number | "">>(new Map());

  useEffect(() => {
    if (categories.data)
      setCats(new Set(categories.data.filter((c) => c.selected).map((c) => c.ext_id)));
  }, [categories.data]);
  useEffect(() => {
    if (entities.data) {
      setEnts(new Set(entities.data.filter((e) => e.selected).map((e) => e.ext_id)));
      setModes(new Map(entities.data.map((e) => [e.ext_id, e.mode ?? ""])));
      setThresholds(new Map(entities.data.map((e) => [e.ext_id, e.auto_min_confidence ?? ""])));
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

  function setThreshold(id: number, value: number | "") {
    const next = new Map(thresholds);
    next.set(id, value);
    setThresholds(next);
  }

  const hasAuto = [...modes.values()].some((m) => m === "semi_auto" || m === "full_auto");

  async function save() {
    try {
      await Api.setScope({ category_ids: [...cats], entity_ids: [...ents] });
      await Api.saveModes(
        [...modes].map(([ext_id, mode]) => {
          const thr = thresholds.get(ext_id);
          return {
            ext_id,
            mode: mode || null,
            // Seuil envoyé uniquement en semi-auto (sinon null = défaut global).
            auto_min_confidence:
              mode === "semi_auto" && thr !== "" && thr != null ? Number(thr) : null,
          };
        }),
      );
      toast.success(t("Périmètre et modes enregistrés.", "Scope and modes saved."));
    } catch (e: unknown) {
      toast.error((e as Error).message);
    }
  }

  /** Bascule tout sélectionné / tout désélectionné selon l'état courant. */
  function toggleAll(ids: number[], current: Set<number>, setter: (s: Set<number>) => void) {
    const allOn = ids.length > 0 && ids.every((id) => current.has(id));
    setter(allOn ? new Set() : new Set(ids));
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

  // Compteur d'entités passées en autonomie (semi/full) pour le résumé.
  const autoCount = [...modes].filter(
    ([id, m]) => ents.has(id) && (m === "semi_auto" || m === "full_auto"),
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-[12px] text-muted-foreground">
          {t(
            "Catégories et entités que l'IA a le droit d'utiliser. Hors périmètre → « à trier ».",
            "Categories and entities the AI may use. Out of scope → “to triage”.",
          )}
        </p>
        <SyncButton onSynced={reload} />
      </div>

      {/* Résumé du périmètre courant. */}
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-[12px]">
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <Layers className="h-3.5 w-3.5 text-accent-indigo" />
          <span className="font-medium text-foreground">{cats.size}</span>
          {t("catégorie(s) autorisée(s)", "allowed categories")}
        </span>
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <FolderTree className="h-3.5 w-3.5 text-accent-indigo" />
          <span className="font-medium text-foreground">{ents.size}</span>
          {t("entité(s) dans le périmètre", "entities in scope")}
        </span>
        {autoCount > 0 && (
          <Tag tone="amber">
            <AlertTriangle className="h-3 w-3" />
            {t(`${autoCount} en autonomie`, `${autoCount} autonomous`)}
          </Tag>
        )}
      </Card>

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
            subtitle={`${cats.size} / ${categories.data?.length ?? 0} ${t("sélectionnée(s)", "selected")}`}
            right={
              (categories.data?.length ?? 0) > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    toggleAll(
                      (categories.data ?? []).map((c) => c.ext_id),
                      cats,
                      setCats,
                    )
                  }
                >
                  {cats.size === (categories.data?.length ?? 0) ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <CheckSquare className="h-3.5 w-3.5" />
                  )}
                  {cats.size === (categories.data?.length ?? 0)
                    ? t("Tout désélectionner", "Deselect all")
                    : t("Tout sélectionner", "Select all")}
                </Button>
              ) : undefined
            }
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
            subtitle={`${ents.size} / ${entities.data?.length ?? 0} ${t("sélectionnée(s)", "selected")} · ${t("mode par entité", "mode per entity")}`}
            right={
              (entities.data?.length ?? 0) > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    toggleAll(
                      (entities.data ?? []).map((e) => e.ext_id),
                      ents,
                      setEnts,
                    )
                  }
                >
                  {ents.size === (entities.data?.length ?? 0) ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <CheckSquare className="h-3.5 w-3.5" />
                  )}
                  {ents.size === (entities.data?.length ?? 0)
                    ? t("Tout désélectionner", "Deselect all")
                    : t("Tout sélectionner", "Select all")}
                </Button>
              ) : undefined
            }
          />
          <CheckList
            items={entities.data ?? []}
            selected={ents}
            onToggle={(id, on) => toggle(ents, setEnts, id, on)}
            empty={t("Scannez GLPI pour lister les entités.", "Scan GLPI to list entities.")}
            trailing={(it) => {
              const m = modes.get(it.ext_id) ?? "";
              return (
                <div className="flex shrink-0 items-center gap-2">
                  {m && (
                    <span
                      aria-hidden
                      className={cn(
                        "h-2 w-2 rounded-full",
                        m === "full_auto"
                          ? "bg-destructive"
                          : m === "semi_auto"
                            ? "bg-warning"
                            : "bg-muted-foreground/50",
                      )}
                    />
                  )}
                  <select
                    aria-label={t(`Mode pour ${it.name}`, `Mode for ${it.name}`)}
                    className={cn(
                      "rounded-md border bg-card px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      m === "full_auto"
                        ? "border-destructive/40 text-destructive"
                        : m === "semi_auto"
                          ? "border-warning/40 text-warning"
                          : "border-input text-muted-foreground hover:border-muted-foreground/40",
                    )}
                    value={m}
                    onChange={(e) => setMode(it.ext_id, e.target.value as ExecutionMode | "")}
                  >
                    {MODE_OPTIONS.map((o) => (
                      <option key={o.value || "default"} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {m === "semi_auto" && (
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={thresholds.get(it.ext_id) ?? ""}
                      placeholder="0.9"
                      aria-label={t(
                        `Seuil semi-auto pour ${it.name}`,
                        `Semi-auto threshold for ${it.name}`,
                      )}
                      title={t(
                        "Seuil de confiance requis pour appliquer en semi-auto (vide = défaut global)",
                        "Confidence threshold to apply in semi-auto (empty = global default)",
                      )}
                      onChange={(e) =>
                        setThreshold(it.ext_id, e.target.value === "" ? "" : Number(e.target.value))
                      }
                      className="w-16 rounded-md border border-warning/40 bg-card px-2 py-1 text-[11px] text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    />
                  )}
                </div>
              );
            }}
          />
        </Card>
      </div>

      {/* Légende des modes par entité. */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>{t("Modes :", "Modes:")}</span>
        <Tag tone={MODE_TONE.suggestion}>{t("Suggestion", "Suggestion")}</Tag>
        <Tag tone={MODE_TONE.semi_auto}>{t("Semi-auto", "Semi-auto")}</Tag>
        <Tag tone={MODE_TONE.full_auto}>{t("Full-auto", "Full-auto")}</Tag>
        <span className="text-muted-foreground/70">
          {t("— autonomie croissante", "— increasing autonomy")}
        </span>
      </div>

      <Button onClick={save}>
        <Save className="h-4 w-4" />
        {t("Enregistrer le périmètre et les modes", "Save scope and modes")}
      </Button>
    </div>
  );
}
