import { CheckCircle2, Search, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { SkillCoverageBanner } from "@/components/SkillCoverage";
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
import { Api, type EligibilityItem, type RefItem, type RefKind, type SkillDomain } from "@/lib/api";
import { useLang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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
  const { lang } = useLang();
  const toast = useToast();
  const res = useResource(useCallback(() => Api.discovery(kind), [kind]));
  const [draft, setDraft] = useState<
    Record<number, { eligible: boolean; skills: string; skill_tags: string[] }>
  >({});
  // Catalogue chargé depuis l'API : le dupliquer côté client ferait cocher des clés que
  // le moteur ignorerait ensuite en silence. Un échec de chargement n'est PAS bloquant —
  // la prose libre reste utilisable, on n'ampute pas la page pour une liste d'aide.
  const [catalog, setCatalog] = useState<SkillDomain[]>([]);
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState(ALL);
  const [eligibleOnly, setEligibleOnlyState] = useState(() => readEligibleOnly(kind));
  const [saving, setSaving] = useState(false);
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
          res.data.map((r) => [
            r.ext_id,
            { eligible: r.eligible, skills: r.skills, skill_tags: r.skill_tags ?? [] },
          ]),
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

  // Couverture par domaine telle qu'elle est À L'ÉCRAN (brouillon compris) : le bandeau
  // de diagnostic doit réagir à la case qu'on vient de cocher, pas à l'état enregistré.
  const liveCoverage = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of items) {
      const d = draft[r.ext_id];
      if (!(d?.eligible ?? r.eligible)) continue;
      for (const k of d?.skill_tags ?? r.skill_tags ?? []) counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  }, [items, draft]);

  useEffect(() => {
    let vivant = true;
    Api.skillCatalog()
      .then((c) => vivant && setCatalog(c))
      .catch(() => undefined); // non bloquant : la prose reste saisissable
    return () => {
      vivant = false;
    };
  }, []);

  function toggleTag(id: number, key: string, coche: boolean) {
    setDraft((d) => {
      const actuel = d[id]?.skill_tags ?? [];
      return {
        ...d,
        [id]: {
          ...d[id],
          skill_tags: coche ? [...actuel, key] : actuel.filter((k) => k !== key),
        },
      };
    });
  }

  function patch(
    id: number,
    p: Partial<{ eligible: boolean; skills: string; skill_tags: string[] }>,
  ) {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...p } }));
  }

  async function onSave() {
    setSaving(true);
    try {
      await save(Object.entries(draft).map(([ext_id, v]) => ({ ext_id: Number(ext_id), ...v })));
      res.reload();
      toast.success(t("Enregistré.", "Saved."));
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-[12px] text-muted-foreground">{desc}</p>
        <SyncButton onSynced={res.reload} />
      </div>

      {/* Tant qu'aucun acteur n'est éligible, la carte annoncerait « 14 domaines non
          couverts » : c'est du bruit sur une instance qu'on vient de scanner, pas un
          diagnostic. Elle n'apparaît qu'une fois la configuration commencée. */}
      {eligibleCount > 0 && <SkillCoverageBanner kind={kind} live={liveCoverage} />}

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
              const d = draft[r.ext_id] ?? {
                eligible: r.eligible,
                skills: r.skills,
                skill_tags: r.skill_tags ?? [],
              };
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
                  {d.eligible && catalog.length > 0 && (
                    <div className="mt-3 pl-[44px]">
                      <p className="mb-1.5 text-[11.5px] text-muted-foreground">
                        {t(
                          "Domaines pris en charge — cochez pour décrire ce technicien sans rien rédiger.",
                          "Supported domains — tick to describe this technician without writing anything.",
                        )}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {catalog.map((dom) => {
                          const coche = d.skill_tags.includes(dom.key);
                          return (
                            <button
                              type="button"
                              key={dom.key}
                              title={dom.hint_fr}
                              aria-pressed={coche}
                              onClick={() => toggleTag(r.ext_id, dom.key, !coche)}
                              className={cn(
                                "rounded-full border px-2.5 py-1 text-[11.5px] transition-colors",
                                coche
                                  ? "border-primary/40 bg-primary/15 text-accent-indigo"
                                  : "border-border text-muted-foreground hover:bg-accent/60",
                              )}
                            >
                              {lang === "fr" ? dom.label_fr : dom.label_en}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {d.eligible && (
                    <div className="mt-3 pl-[44px]">
                      <Textarea
                        className="min-h-16 bg-background/40"
                        value={d.skills}
                        placeholder={t(
                          "Précisions libres — exceptions, spécialités, disponibilités…",
                          "Free-form notes — exceptions, specialties, availability…",
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
        <Button onClick={onSave} disabled={saving}>
          {saving
            ? t("Enregistrement…", "Saving…")
            : t("Enregistrer la sélection", "Save selection")}
        </Button>
      )}
    </div>
  );
}
