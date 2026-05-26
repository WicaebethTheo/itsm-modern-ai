import { Banner } from "@/components/Banner";
import { EmptyState } from "@/components/EmptyState";
import { SyncButton } from "@/components/SyncButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, type EligibilityItem, type RefItem, type RefKind } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Search, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ALL = "__all__";

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
  const res = useResource(useCallback(() => Api.discovery(kind), [kind]));
  const [draft, setDraft] = useState<Record<number, { eligible: boolean; skills: string }>>({});
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState(ALL);
  const [eligibleOnly, setEligibleOnly] = useState(false);

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
    setMsg(null);
    try {
      await save(Object.entries(draft).map(([ext_id, v]) => ({ ext_id: Number(ext_id), ...v })));
      res.reload();
      setMsg({ kind: "success", text: t("Enregistré.", "Saved.") });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted-foreground">{desc}</p>
        <SyncButton onSynced={res.reload} />
      </div>
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

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
            subtitle={t(
              `${eligibleCount} éligible(s) · ${filtered.length}/${items.length} affiché(s)`,
              `${eligibleCount} eligible · ${filtered.length}/${items.length} shown`,
            )}
          />
          {/* Barre d'outils */}
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
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
                className="h-9 rounded-md border border-input bg-card px-3 text-[12.5px]"
              >
                <option value={ALL}>{t("Tous les profils", "All profiles")}</option>
                {profiles.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
            <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
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
                  className={`px-4 py-3 ${i < filtered.length - 1 ? "border-b border-border" : ""}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <label className="flex flex-1 cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={d.eligible}
                        onChange={(e) => patch(r.ext_id, { eligible: e.target.checked })}
                      />
                      <span className="text-[13px] font-medium">
                        {r.name}{" "}
                        <span className="font-mono text-muted-foreground">#{r.ext_id}</span>
                      </span>
                    </label>
                    {r.profile && <Tag tone="muted">{r.profile}</Tag>}
                  </div>
                  {d.eligible && (
                    <Textarea
                      className="mt-3"
                      value={d.skills}
                      placeholder={t(
                        "Compétences / domaines (prose) — sert au routage de l'IA…",
                        "Skills / domains (prose) — used for AI routing…",
                      )}
                      onChange={(e) => patch(r.ext_id, { skills: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
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
