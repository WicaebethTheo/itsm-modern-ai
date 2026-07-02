import { EmptyState } from "@/components/EmptyState";
import { SyncButton } from "@/components/SyncButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, type EligibilityItem, type RefItem, type RefKind } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CheckCircle2, Search, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ALL = "__all__";

/** Préférence UI persistée par RefKind (technicien/groupe) : survit aux changements de page. */
function eligibleOnlyKey(kind: RefKind) {
  return `ui.refEditor.${kind}.eligibleOnly`;
}
function readEligibleOnly(kind: RefKind): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(eligibleOnlyKey(kind)) === "1";
  } catch {
    return false;
  }
}

/** Monogramme : initiales dérivées du nom, pour repérer une ligne d'un coup d'œil. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Éditeur d'éligibilité (techniciens / groupes) : scan GLPI, puis on coche qui est
 * éligible et on décrit ses compétences. Tout en base, édité dans la console.
 */
export function RefEligibilityEditor({
  kind,
  save,
}: {
  kind: RefKind;
  save: (items: EligibilityItem[]) => Promise<RefItem[]>;
}) {
  const t = useT();
  const toast = useToast();
  const res = useResource(useCallback(() => Api.discovery(kind), [kind]));
  const [draft, setDraft] = useState<Record<number, { eligible: boolean; skills: string }>>({});
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState(ALL);
  const [eligibleOnly, setEligibleOnlyState] = useState(() => readEligibleOnly(kind));
  // Wrapper qui persiste la préférence : survit au démontage et à la navigation.
  const setEligibleOnly = useCallback(
    (next: boolean) => {
      setEligibleOnlyState(next);
      try {
        window.localStorage.setItem(eligibleOnlyKey(kind), next ? "1" : "0");
      } catch {
        /* localStorage indisponible (mode privé strict, etc.) — comportement par défaut. */
      }
    },
    [kind],
  );

  const title = kind === "technician" ? t("Techniciens", "Technicians") : t("Groupes", "Groups");
  const desc =
    kind === "technician"
      ? t(
          "Scannés depuis GLPI. Cochez ceux vers qui l'IA peut router et décrivez leurs compétences.",
          "Scanned from GLPI. Tick those the AI may route to and describe their skills.",
        )
      : t(
          "Cibles de repli. Cochez les groupes éligibles et décrivez-les.",
          "Fallback targets. Tick eligible groups and describe them.",
        );

  useEffect(() => {
    if (res.data) {
      setDraft(
        Object.fromEntries(
          res.data.map((r) => [r.ext_id, { eligible: r.eligible, skills: r.skills }]),
        ),
      );
    }
  }, [res.data]);

  const profiles = useMemo(() => {
    const set = new Set<string>();
    for (const r of res.data ?? []) if (r.profile) set.add(r.profile);
    return [...set].sort();
  }, [res.data]);

  const items = res.data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((r) => {
      if (profile !== ALL && r.profile !== profile) return false;
      if (eligibleOnly && !(draft[r.ext_id]?.eligible ?? r.eligible)) return false;
      if (q && !`${r.name} #${r.ext_id} ${r.profile}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, query, profile, eligibleOnly, draft]);

  const eligibleCount = items.filter((r) => draft[r.ext_id]?.eligible ?? r.eligible).length;

  function patch(id: number, p: Partial<{ eligible: boolean; skills: string }>) {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...p } }));
  }

  async function onSave() {
    try {
      await save(Object.entries(draft).map(([ext_id, v]) => ({ ext_id: Number(ext_id), ...v })));
      res.reload();
      toast.success(t("Enregistré.", "Saved."));
    } catch (e: unknown) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-[12px] text-muted-foreground">{desc}</p>
        <SyncButton onSynced={res.reload} />
      </div>

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={t("Aucun élément", "Nothing yet")}
            description={t(
              "Cliquez sur « Scanner GLPI » pour récupérer la liste depuis votre instance.",
              "Click “Scan GLPI” to fetch the list from your instance.",
            )}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <PanelHead
            title={title}
            subtitle={
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                {t(
                  `${eligibleCount} éligible(s) · ${filtered.length}/${items.length} affiché(s)`,
                  `${eligibleCount} eligible · ${filtered.length}/${items.length} shown`,
                )}
              </span>
            }
          />
          {/* Barre d'outils */}
          <div className="flex flex-wrap items-center gap-2.5 border-b border-border bg-muted/30 px-4 py-3">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                placeholder={t("Rechercher par nom ou ID…", "Search by name or ID…")}
                className="pl-9"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {profiles.length > 0 && (
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className="h-9 rounded-md border border-input bg-card px-3 text-[12.5px] transition-colors hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <option value={ALL}>{t("Tous les profils", "All profiles")}</option>
                {profiles.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
            <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-card px-3 text-[12.5px] text-muted-foreground">
              <Toggle checked={eligibleOnly} onChange={setEligibleOnly} />
              {t("Éligibles seulement", "Eligible only")}
            </label>
          </div>

          <div className="flex flex-col">
            {filtered.map((r, i) => {
              const d = draft[r.ext_id] ?? { eligible: r.eligible, skills: r.skills };
              return (
                <div
                  key={r.ext_id}
                  className={cn(
                    "px-4 py-3 transition-colors",
                    i < filtered.length - 1 && "border-b border-border",
                    d.eligible ? "bg-primary/[0.04]" : "hover:bg-accent/40",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <label className="flex flex-1 cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={d.eligible}
                        onChange={(e) => patch(r.ext_id, { eligible: e.target.checked })}
                      />
                      <span
                        aria-hidden
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
                          d.eligible
                            ? "bg-primary/15 text-accent-indigo"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {initials(r.name)}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium">
                          {r.name}{" "}
                          <span className="font-mono text-[11px] text-muted-foreground">
                            #{r.ext_id}
                          </span>
                        </span>
                      </span>
                    </label>
                    {d.eligible && (
                      <Tag tone="green">
                        <CheckCircle2 className="h-3 w-3" />
                        {t("Éligible", "Eligible")}
                      </Tag>
                    )}
                    {r.profile && <Tag tone="muted">{r.profile}</Tag>}
                  </div>
                  {d.eligible && (
                    <div className="mt-3 pl-[44px]">
                      <Textarea
                        className="min-h-16 bg-background/40"
                        value={d.skills}
                        placeholder={t(
                          "Compétences / domaines (prose) — sert au routage de l'IA…",
                          "Skills / domains (prose) — used for AI routing…",
                        )}
                        onChange={(e) => patch(r.ext_id, { skills: e.target.value })}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">
                {t("Aucun résultat pour ce filtre.", "No result for this filter.")}
              </p>
            )}
          </div>
        </Card>
      )}
      {items.length > 0 && (
        <Button onClick={onSave}>{t("Enregistrer la sélection", "Save selection")}</Button>
      )}
    </div>
  );
}
