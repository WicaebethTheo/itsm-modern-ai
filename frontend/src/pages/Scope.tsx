import {
  AlertTriangle,
  CheckSquare,
  FolderTree,
  Layers,
  Loader2,
  Save,
  Search,
  Square,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/Banner";
import { dernierScan, SyncButton } from "@/components/SyncButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PanelHead } from "@/components/ui/panel";
import { Tag, type TagTone } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api, type ExecutionMode, type RefItem } from "@/lib/api";
import { tr, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Couleur du badge de mode : neutre → amber → rouge selon l'autonomie accordée. */
const MODE_TONE: Record<ExecutionMode, TagTone> = {
  suggestion: "muted",
  semi_auto: "amber",
  full_auto: "red",
};

/**
 * Liste cochable — avec trois états DISTINCTS : chargement, erreur, vide.
 *
 * Ils étaient confondus : une lecture de `/api/discovery/*` en 500 affichait « Scannez GLPI
 * pour lister les catégories », exactement comme une instance jamais scannée. L'admin
 * cliquait « Scanner GLPI », ça échouait encore, et rien ne lui disait pourquoi.
 */
function CheckList({
  items,
  selected,
  onToggle,
  empty,
  loading,
  error,
  trailing,
}: {
  items: RefItem[];
  selected: Set<number>;
  onToggle: (id: number, on: boolean) => void;
  empty: string;
  loading?: boolean;
  error?: string | null;
  trailing?: (it: RefItem) => ReactNode;
}) {
  if (error && items.length === 0)
    return (
      <p className="flex items-start justify-center gap-1.5 px-4 py-8 text-center text-[12.5px] text-destructive">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {tr(
            "Impossible de lire les référentiels — vérifiez la connexion GLPI.",
            "Cannot read referentials — check the GLPI connection.",
          )}{" "}
          <span className="opacity-80">{error}</span>
        </span>
      </p>
    );
  if (loading && items.length === 0)
    return (
      <p className="flex items-center justify-center gap-2 px-4 py-8 text-center text-[12.5px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {tr("Chargement…", "Loading…")}
      </p>
    );
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
              // `flex-wrap` : la ligne d'entité porte jusqu'à trois contrôles `shrink-0`
              // (mode, repli, seuil) ; sous ~900 px le nom se réduisait à néant. Ils
              // retombent désormais sous le nom au lieu de l'écraser.
              "flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5 text-[12.5px] transition-colors",
              i < items.length - 1 && "border-b border-border/50",
              on ? "bg-primary/[0.04]" : "hover:bg-accent/40",
            )}
          >
            <label className="flex min-w-40 flex-1 cursor-pointer items-center gap-2.5">
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

/** Réglages d'une entité tels que le SERVEUR les a enregistrés (comparés au brouillon). */
function reglagesServeur(e: RefItem): string {
  const mode = e.mode ?? "";
  const conf = mode === "semi_auto" && e.auto_min_confidence != null ? e.auto_min_confidence : null;
  const repli =
    e.fallback_group_id != null
      ? `g:${e.fallback_group_id}`
      : e.fallback_technician_id != null
        ? `t:${e.fallback_technician_id}`
        : "";
  return `${mode}|${conf}|${repli}`;
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
  // Cible de repli par entité, encodée `g:<id>` / `t:<id>` ("" = aucun repli). Un seul
  // contrôle plutôt que deux listes : les deux cibles s'excluent, et la ligne est déjà dense.
  const [fallbacks, setFallbacks] = useState<Map<number, string>>(new Map());
  // Acteurs ÉLIGIBLES : seuls candidats légitimes au repli (le backend refuse les autres).
  const groups = useResource(useCallback(() => Api.discovery("group"), []));
  const technicians = useResource(useCallback(() => Api.discovery("technician"), []));
  const [saving, setSaving] = useState(false);
  // Recherche par panneau : 200 catégories dans une lucarne `max-h-96` sans filtre, on ne
  // trouve rien. Un état par liste — filtrer les catégories ne doit pas masquer des entités.
  const [catQuery, setCatQuery] = useState("");
  const [entQuery, setEntQuery] = useState("");

  // Une saisie locale est en attente. « Scanner GLPI » recharge les référentiels, donc
  // `categories.data` / `entities.data` changent et les effets d'initialisation ci-dessous
  // se rejouent : sans ce garde, ils repartaient du serveur et effaçaient en silence les
  // cases cochées, les modes et les seuils que l'admin venait de régler. Remis à faux après
  // un enregistrement réussi — l'état serveur redevient alors la référence.
  const touched = useRef(false);

  useEffect(() => {
    if (categories.data && !touched.current)
      setCats(new Set(categories.data.filter((c) => c.selected).map((c) => c.ext_id)));
  }, [categories.data]);
  useEffect(() => {
    if (entities.data && !touched.current) {
      setEnts(new Set(entities.data.filter((e) => e.selected).map((e) => e.ext_id)));
      setModes(new Map(entities.data.map((e) => [e.ext_id, e.mode ?? ""])));
      setThresholds(new Map(entities.data.map((e) => [e.ext_id, e.auto_min_confidence ?? ""])));
      setFallbacks(
        new Map(
          entities.data.map((e) => [
            e.ext_id,
            e.fallback_group_id != null
              ? `g:${e.fallback_group_id}`
              : e.fallback_technician_id != null
                ? `t:${e.fallback_technician_id}`
                : "",
          ]),
        ),
      );
    }
  }, [entities.data]);

  function toggle(set: Set<number>, setter: (s: Set<number>) => void, id: number, on: boolean) {
    touched.current = true;
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    setter(next);
  }

  function setMode(id: number, mode: ExecutionMode | "") {
    touched.current = true;
    const next = new Map(modes);
    next.set(id, mode);
    setModes(next);
  }

  function setFallback(id: number, value: string) {
    touched.current = true;
    const next = new Map(fallbacks);
    next.set(id, value);
    setFallbacks(next);
  }

  function setThreshold(id: number, value: number | "") {
    touched.current = true;
    const next = new Map(thresholds);
    next.set(id, value);
    setThresholds(next);
  }

  const hasAuto = [...modes.values()].some((m) => m === "semi_auto" || m === "full_auto");

  /** Réglages d'une entité tels qu'ils PARTIRONT au serveur (même normalisation que `save`). */
  const reglagesLocaux = useCallback(
    (id: number) => {
      const mode = modes.get(id) ?? "";
      const thr = thresholds.get(id);
      const repli = fallbacks.get(id) ?? "";
      const conf = mode === "semi_auto" && thr !== "" && thr != null ? Number(thr) : null;
      return `${mode}|${conf}|${repli}`;
    },
    [modes, thresholds, fallbacks],
  );

  // Ce qui est modifié à l'écran et pas encore parti au serveur. Sans ce compteur, rien ne
  // distinguait « je viens de tout régler » de « la page est telle que je l'ai trouvée ».
  const enAttente = useMemo(() => {
    let n = 0;
    for (const c of categories.data ?? []) if (cats.has(c.ext_id) !== c.selected) n++;
    for (const e of entities.data ?? []) {
      if (ents.has(e.ext_id) !== e.selected) n++;
      if (reglagesLocaux(e.ext_id) !== reglagesServeur(e)) n++;
    }
    return n;
  }, [categories.data, entities.data, cats, ents, reglagesLocaux]);

  async function save() {
    setSaving(true);
    try {
      await Api.setScope({ category_ids: [...cats], entity_ids: [...ents] });
      await Api.saveModes(
        [...modes].map(([ext_id, mode]) => {
          const thr = thresholds.get(ext_id);
          const repli = fallbacks.get(ext_id) ?? "";
          return {
            ext_id,
            mode: mode || null,
            // Seuil envoyé uniquement en semi-auto (sinon null = défaut global).
            auto_min_confidence:
              mode === "semi_auto" && thr !== "" && thr != null ? Number(thr) : null,
            fallback_group_id: repli.startsWith("g:") ? Number(repli.slice(2)) : null,
            fallback_technician_id: repli.startsWith("t:") ? Number(repli.slice(2)) : null,
          };
        }),
      );
      // Le serveur redevient la référence : un scan ultérieur peut rafraîchir sans risque,
      // et la relecture remet le compteur de modifications en attente à zéro sur ce que le
      // serveur a RÉELLEMENT accepté — pas sur ce qu'on croit lui avoir envoyé.
      touched.current = false;
      reload();
      toast.success(t("Périmètre et modes enregistrés.", "Scope and modes saved."));
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Bascule les identifiants AFFICHÉS (donc filtrés), jamais toute la liste.
   *
   * Le piège à ne pas ouvrir : chercher « imprimante », cliquer « Tout sélectionner » et
   * mettre les 200 catégories de l'instance dans le périmètre. Les lignes masquées par la
   * recherche gardent leur état — d'où l'union/soustraction plutôt qu'un remplacement.
   */
  function toggleAll(ids: number[], current: Set<number>, setter: (s: Set<number>) => void) {
    touched.current = true;
    const allOn = ids.length > 0 && ids.every((id) => current.has(id));
    const next = new Set(current);
    for (const id of ids) {
      if (allOn) next.delete(id);
      else next.add(id);
    }
    setter(next);
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

  const filtre = (items: RefItem[], q: string) => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((it) => `${it.name} #${it.ext_id}`.toLowerCase().includes(s));
  };
  const catsFiltrees = filtre(categories.data ?? [], catQuery);
  const entsFiltrees = filtre(entities.data ?? [], entQuery);

  /** Bouton de cochage en masse — porte le nombre d'AFFICHÉS, pour ne rien promettre d'autre. */
  const boutonMasse = (
    affiches: RefItem[],
    current: Set<number>,
    setter: (s: Set<number>) => void,
    filtreActif: boolean,
  ) => {
    if (affiches.length === 0) return undefined;
    const ids = affiches.map((it) => it.ext_id);
    const tous = ids.every((id) => current.has(id));
    return (
      <Button variant="ghost" size="sm" onClick={() => toggleAll(ids, current, setter)}>
        {tous ? <Square className="h-3.5 w-3.5" /> : <CheckSquare className="h-3.5 w-3.5" />}
        {filtreActif
          ? tous
            ? t(`Décocher les ${ids.length} affichés`, `Untick the ${ids.length} shown`)
            : t(`Cocher les ${ids.length} affichés`, `Tick the ${ids.length} shown`)
          : tous
            ? t("Tout désélectionner", "Deselect all")
            : t("Tout sélectionner", "Select all")}
      </Button>
    );
  };

  const barreRecherche = (
    value: string,
    onChange: (v: string) => void,
    label: string,
    placeholder: string,
  ) => (
    <div className="border-b border-border bg-muted/30 px-4 py-2.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={value}
          aria-label={label}
          placeholder={placeholder}
          className="pl-9"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );

  // Fraîcheur du cache : le plus récent des deux scans affichés sur cette page.
  const lastSync = dernierScan([...(categories.data ?? []), ...(entities.data ?? [])]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[12px] text-muted-foreground">
          {t(
            "Catégories et entités que l'IA a le droit d'utiliser. Hors périmètre → « à trier ».",
            "Categories and entities the AI may use. Out of scope → “to triage”.",
          )}
        </p>
        <SyncButton onSynced={reload} lastSync={lastSync} />
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

      {/* PÉRIMÈTRE INOPÉRANT. `domain/whitelist.check()` rejette TOUTE décision dont la
          catégorie n'est pas autorisée : zéro catégorie cochée = 100 % des tickets « à
          trier », moteur allumé pour rien. C'est l'état le plus grave de cette page, il
          doit être le plus visible. */}
      {(categories.data?.length ?? 0) > 0 && cats.size === 0 && (
        <Banner kind="error">
          <span className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>{t("Aucune catégorie autorisée", "No allowed category")}</strong>{" "}
              {t(
                "— le garde-fou rejettera toutes les décisions : 100 % des tickets partiront « à trier ». Cochez au moins une catégorie.",
                "— the guardrail will reject every decision: 100% of tickets will end up “to sort”. Tick at least one category.",
              )}
            </span>
          </span>
        </Banner>
      )}

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
            subtitle={
              <span role="status" aria-live="polite">
                {`${cats.size} / ${categories.data?.length ?? 0} ${t("sélectionnée(s)", "selected")}`}
                {catQuery.trim() !== "" && ` · ${catsFiltrees.length} ${t("affichée(s)", "shown")}`}
              </span>
            }
            right={boutonMasse(catsFiltrees, cats, setCats, catQuery.trim() !== "")}
          />
          {(categories.data?.length ?? 0) > 0 &&
            barreRecherche(
              catQuery,
              setCatQuery,
              t("Rechercher une catégorie", "Search a category"),
              t("Rechercher par nom ou ID…", "Search by name or ID…"),
            )}
          <CheckList
            items={catsFiltrees}
            selected={cats}
            onToggle={(id, on) => toggle(cats, setCats, id, on)}
            loading={categories.loading}
            error={categories.error}
            empty={
              catQuery.trim() !== ""
                ? t("Aucun résultat pour cette recherche.", "No result for this search.")
                : t("Scannez GLPI pour lister les catégories.", "Scan GLPI to list categories.")
            }
          />
        </Card>
        <Card className="overflow-hidden">
          <PanelHead
            title={t("Entités du périmètre", "Scope entities")}
            subtitle={
              <span role="status" aria-live="polite">
                {`${ents.size} / ${entities.data?.length ?? 0} ${t("sélectionnée(s)", "selected")} · ${t("mode par entité", "mode per entity")}`}
                {entQuery.trim() !== "" && ` · ${entsFiltrees.length} ${t("affichée(s)", "shown")}`}
              </span>
            }
            right={boutonMasse(entsFiltrees, ents, setEnts, entQuery.trim() !== "")}
          />
          {(entities.data?.length ?? 0) > 0 &&
            barreRecherche(
              entQuery,
              setEntQuery,
              t("Rechercher une entité", "Search an entity"),
              t("Rechercher par nom ou ID…", "Search by name or ID…"),
            )}
          <CheckList
            items={entsFiltrees}
            selected={ents}
            onToggle={(id, on) => toggle(ents, setEnts, id, on)}
            loading={entities.loading}
            error={entities.error}
            empty={
              entQuery.trim() !== ""
                ? t("Aucun résultat pour cette recherche.", "No result for this search.")
                : t("Scannez GLPI pour lister les entités.", "Scan GLPI to list entities.")
            }
            trailing={(it) => {
              const m = modes.get(it.ext_id) ?? "";
              return (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                  {m !== "suggestion" && (
                    <select
                      aria-label={t(`Repli pour ${it.name}`, `Fallback for ${it.name}`)}
                      title={t(
                        "Acteur assigné quand le garde-fou refuse une décision — le ticket n'est ni catégorisé ni priorisé, seulement routé. Sans effet en mode suggestion.",
                        "Actor assigned when the guardrail rejects a decision — the ticket is neither categorised nor prioritised, only routed. No effect in suggestion mode.",
                      )}
                      value={fallbacks.get(it.ext_id) ?? ""}
                      onChange={(e) => setFallback(it.ext_id, e.target.value)}
                      className="max-w-40 rounded-md border border-input bg-card px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      <option value="">{t("Repli : aucun", "Fallback: none")}</option>
                      {/* Groupes d'abord : un groupe encaisse une absence, pas une personne. */}
                      {(groups.data ?? [])
                        .filter((g) => g.eligible)
                        .map((g) => (
                          <option key={`g:${g.ext_id}`} value={`g:${g.ext_id}`}>
                            {t("Groupe", "Group")} {g.name}
                          </option>
                        ))}
                      {(technicians.data ?? [])
                        .filter((x) => x.eligible)
                        .map((x) => (
                          <option key={`t:${x.ext_id}`} value={`t:${x.ext_id}`}>
                            {x.name}
                          </option>
                        ))}
                    </select>
                  )}
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

      {/* Barre d'enregistrement collante : le bouton passait sous la liste dépliée, on
          cochait, on quittait la page et tout était perdu sans un mot. */}
      <div
        className={cn(
          "sticky bottom-0 z-20 -mx-5 -mb-5 mt-2 border-t border-border bg-card/95 backdrop-blur",
          "supports-[backdrop-filter]:bg-card/80 sm:-mx-6 sm:-mb-6",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6">
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "text-[12px]",
              enAttente > 0 ? "font-medium text-warning" : "text-muted-foreground",
            )}
          >
            {enAttente > 0
              ? t(
                  `${enAttente} modification(s) non enregistrée(s)`,
                  `${enAttente} unsaved change(s)`,
                )
              : t("Aucune modification en attente", "No pending change")}
          </p>
          <Button onClick={save} disabled={saving || enAttente === 0}>
            <Save className="h-4 w-4" />
            {saving
              ? t("Enregistrement…", "Saving…")
              : t("Enregistrer le périmètre et les modes", "Save scope and modes")}
          </Button>
        </div>
      </div>
    </div>
  );
}
