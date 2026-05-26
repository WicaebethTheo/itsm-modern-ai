import { EmptyState } from "@/components/EmptyState";
import { Banner, PageHeader } from "@/components/PageHeader";
import { SyncButton } from "@/components/SyncButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, type EligibilityItem, type RefItem, type RefKind } from "@/lib/api";
import { Search, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ALL = "__all__";

/**
 * Éditeur d'éligibilité (techniciens / groupes) : scan GLPI, puis on coche qui est
 * éligible et on décrit ses compétences. Le scan ramène TOUS les utilisateurs : on
 * filtre par profil GLPI + recherche pour ne garder que les bons.
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
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState(ALL);
  const [eligibleOnly, setEligibleOnly] = useState(false);

  useEffect(() => {
    if (res.data) {
      setDraft(
        Object.fromEntries(
          res.data.map((r) => [r.ext_id, { eligible: r.eligible, skills: r.skills }]),
        ),
      );
    }
  }, [res.data]);

  // Profils distincts présents dans les données (pour le filtre).
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

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="Aucun élément"
            description="Cliquez sur « Scanner GLPI » pour récupérer la liste depuis votre instance."
          />
        </Card>
      ) : (
        <>
          {/* Barre d'outils : recherche + filtre profil + éligibles seulement + compteur */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                placeholder="Rechercher par nom ou ID…"
                className="pl-9"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {profiles.length > 0 && (
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              >
                <option value={ALL}>Tous les profils</option>
                {profiles.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
            <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Toggle checked={eligibleOnly} onChange={setEligibleOnly} />
              Éligibles seulement
            </label>
            <span className="ml-auto text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{eligibleCount}</span> éligible(s) ·{" "}
              {filtered.length}/{items.length} affiché(s)
            </span>
          </div>

          <div className="flex flex-col gap-2">
            {filtered.map((r) => {
              const d = draft[r.ext_id] ?? { eligible: r.eligible, skills: r.skills };
              return (
                <Card key={r.ext_id} className={d.eligible ? "border-primary/40" : undefined}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      <label className="flex flex-1 cursor-pointer items-center gap-3">
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
                      {r.profile && <Badge variant="muted">{r.profile}</Badge>}
                    </div>
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
            {filtered.length === 0 && (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                Aucun résultat pour ce filtre.
              </p>
            )}
          </div>

          <div className="mt-4">
            <Button onClick={onSave}>Enregistrer la sélection</Button>
          </div>
        </>
      )}
    </>
  );
}
