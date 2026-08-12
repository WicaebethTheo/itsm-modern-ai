import {
  AlertTriangle,
  CheckCircle2,
  CheckSquare,
  Loader2,
  Search,
  SearchX,
  Square,
  Users,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/Banner";
import { EmptyState } from "@/components/EmptyState";
import { SkillCoverageBanner } from "@/components/SkillCoverage";
import { dernierScan, SyncButton } from "@/components/SyncButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PanelHead } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, type EligibilityItem, type RefItem, type RefKind, type SkillDomain } from "@/lib/api";
import { useLang, useT } from "@/lib/i18n";
import { cn, SELECTED_CONTROL, SELECTED_ROW, SUBSURFACE } from "@/lib/utils";

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
  rowExtra,
}: {
  kind: RefKind;
  save: (items: EligibilityItem[]) => Promise<RefItem[]>;
  /**
   * Contenu additionnel en bout de ligne, rendu par l'appelant (ex. l'état d'absence d'un
   * technicien). `eligible` vient du BROUILLON : ce qui est coché à l'écran, pas ce qui est
   * enregistré. Les groupes n'en passent pas — un groupe ne part pas en congés.
   */
  rowExtra?: (item: RefItem, eligible: boolean) => ReactNode;
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

  // Les `ext_id` que l'admin a RÉELLEMENT édités — la seule chose que la fusion ci-dessous
  // doit protéger. Sans ce registre, la fusion ne reprenait JAMAIS le serveur pour une
  // ligne existante : le brouillon était peuplé de TOUTES les lignes dès le premier
  // chargement, donc `prev[r.ext_id]` était toujours défini et la branche serveur n'était
  // atteinte que par un acteur nouvellement apparu dans GLPI. Un « Scanner GLPI » n'affichait
  // donc jamais une fiche modifiée ailleurs, le compteur annonçait des modifications que
  // personne n'avait faites, et « Enregistrer » les écrasait avec la valeur périmée.
  // Vidé après un enregistrement réussi : le serveur redevient la référence.
  const edites = useRef<Set<number>>(new Set());

  // FUSION, jamais écrasement : « Scanner GLPI » appelle `res.reload()`, donc `res.data`
  // change et cet effet se rejoue alors que l'admin est en pleine saisie. En repartant du
  // serveur on jetait sans un mot des fiches entières (prose + compétences cochées). On ne
  // reprend donc du serveur que les acteurs dont l'admin n'a rien touché ; un acteur
  // disparu de GLPI sort de la liste, un acteur nouveau y entre avec ses valeurs serveur.
  useEffect(() => {
    const items = res.data;
    if (items) {
      setDraft((prev) =>
        Object.fromEntries(
          items.map((r) => {
            const serveur = {
              eligible: r.eligible,
              skills: r.skills,
              skill_tags: r.skill_tags ?? [],
            };
            // Seules les lignes RÉELLEMENT éditées résistent au serveur. Tester la seule
            // présence dans le brouillon ne marchait pas : il est peuplé de toutes les
            // lignes dès le premier chargement, donc plus aucune ne se rafraîchissait.
            const protegee = edites.current.has(r.ext_id);
            return [r.ext_id, protegee ? (prev[r.ext_id] ?? serveur) : serveur];
          }),
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

  // Ce qui est modifié À L'ÉCRAN et pas encore enregistré. Sans ce compteur, le bouton
  // « Enregistrer » ne disait ni s'il y avait quelque chose à enregistrer, ni combien de
  // fiches étaient en jeu — et il vivait sous soixante fiches dépliées, hors du champ.
  // C'est aussi la LISTE envoyée au serveur : `set_eligibility` écrit par `ext_id`, une
  // ligne inchangée n'a rien à y faire — l'envoyer quand même écrasait la version d'un
  // autre onglet par la valeur qu'on avait lue avant lui.
  const modifiees = useMemo(
    () =>
      items.filter((r) => {
        const d = draft[r.ext_id];
        if (!d) return false;
        const tags = [...(r.skill_tags ?? [])].sort().join(",");
        return (
          d.eligible !== r.eligible ||
          d.skills !== r.skills ||
          [...d.skill_tags].sort().join(",") !== tags
        );
      }),
    [items, draft],
  );
  const modifies = modifiees.length;

  /**
   * Cochage en masse — sur la liste FILTRÉE, jamais sur tout le référentiel.
   *
   * Le piège évident : chercher « réseau », cliquer « Tout sélectionner » et rendre
   * éligibles les 200 techniciens de l'instance. Le bouton porte donc le nombre d'affichés,
   * et n'agit que sur eux : les lignes masquées par le filtre gardent leur état.
   */
  function basculerAffiches() {
    const tous = filtered.every((r) => draft[r.ext_id]?.eligible ?? r.eligible);
    setDraft((d) => {
      const next = { ...d };
      for (const r of filtered) {
        edites.current.add(r.ext_id);
        const actuel = next[r.ext_id] ?? {
          eligible: r.eligible,
          skills: r.skills,
          skill_tags: r.skill_tags ?? [],
        };
        next[r.ext_id] = { ...actuel, eligible: !tous };
      }
      return next;
    });
  }

  const tousAffichesCoches =
    filtered.length > 0 && filtered.every((r) => draft[r.ext_id]?.eligible ?? r.eligible);

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
    edites.current.add(id);
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
    edites.current.add(id);
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...p } }));
  }

  // Le compteur promet « N modifications non enregistrées » : un rechargement les emportait
  // sans un mot. Seul le RECHARGEMENT est gardé — le blocage de navigation interne
  // (`useBlocker`) exige un data router, et `App.tsx` monte un `<BrowserRouter>` déclaratif.
  useEffect(() => {
    return;
  }, [modifies]);

  // Annoncer « N modification(s) non enregistrée(s) » puis laisser un F5 les emporter sans
  // un mot était une demi-promesse. Seul le RECHARGEMENT est gardé : bloquer la navigation
  // interne exige un data router, et l'application monte un `<BrowserRouter>` déclaratif.
  useEffect(() => {
    if (modifies === 0) return;
    const retenir = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", retenir);
    return () => window.removeEventListener("beforeunload", retenir);
  }, [modifies]);

  async function onSave() {
    setSaving(true);
    try {
      // On n'envoie QUE ce qui a changé : `set_eligibility` écrit par `ext_id`, et
      // réexpédier une ligne intacte écrasait la version d'un autre onglet par celle
      // qu'on avait lue avant lui.
      await save(
        modifiees.map((r) => {
          const d = draft[r.ext_id];
          return {
            ext_id: r.ext_id,
            eligible: d.eligible,
            skills: d.skills,
            skill_tags: d.skill_tags,
          };
        }),
      );
      // Le serveur redevient la référence : la relecture doit pouvoir ramener ce qu'il a
      // RÉELLEMENT enregistré, y compris une valeur qu'il a normalisée.
      edites.current.clear();
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-body text-muted-foreground">{desc}</p>
        <SyncButton onSynced={res.reload} lastSync={dernierScan(items)} />
      </div>

      {/* Une lecture en échec ne doit PAS ressembler à une instance jamais scannée : sans
          ce bandeau, un /api/discovery en 500 affichait « Scannez GLPI pour lister… »,
          l'admin rescannait, ça échouait encore, et rien ne disait pourquoi. */}
      {res.error && (
        <Banner kind="error">
          <span className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>
                {t(
                  "Impossible de lire les référentiels — vérifiez la connexion GLPI.",
                  "Cannot read referentials — check the GLPI connection.",
                )}
              </strong>{" "}
              {res.error}
            </span>
          </span>
        </Banner>
      )}

      {/* Tant qu'aucun acteur n'est éligible, la carte de couverture annoncerait « 14
          domaines non couverts » : du bruit sur une instance qu'on vient de scanner. Mais
          se TAIRE dans ce cas était pire — c'est exactement l'état le plus grave : sans
          acteur éligible, `whitelist.check` renvoie NO_ELIGIBLE_ASSIGNEE et 100 % des
          tickets partent « à trier ». On remplace donc le silence par l'alerte. */}
      {eligibleCount > 0 ? (
        <SkillCoverageBanner kind={kind} live={liveCoverage} />
      ) : (
        items.length > 0 && (
          <Banner kind="error">
            <span className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>
                  {kind === "technician"
                    ? t("Aucun technicien éligible", "No eligible technician")
                    : t("Aucun groupe éligible", "No eligible group")}
                </strong>{" "}
                {t(
                  "— le moteur n'a personne vers qui router : tous les tickets partiront « à trier ». Cochez au moins un acteur.",
                  "— the engine has no one to route to: every ticket will end up “to sort”. Tick at least one actor.",
                )}
              </span>
            </span>
          </Banner>
        )
      )}

      {res.loading && items.length === 0 ? (
        <Card>
          <p className="flex items-center justify-center gap-2 px-5 py-10 text-body text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("Chargement des référentiels…", "Loading referentials…")}
          </p>
        </Card>
      ) : items.length === 0 ? (
        // Vide, chargement et erreur sont trois écrans DISTINCTS : en erreur, promettre
        // qu'un scan suffira serait un mensonge, le bandeau ci-dessus a déjà parlé.
        <Card>
          <EmptyState
            icon={Users}
            title={
              res.error
                ? t("Liste indisponible", "List unavailable")
                : t("Aucun élément", "Nothing yet")
            }
            description={
              res.error
                ? t(
                    "La lecture des référentiels a échoué — corrigez la connexion GLPI, puis relancez un scan.",
                    "Reading the referentials failed — fix the GLPI connection, then run a scan.",
                  )
                : t(
                    "Cliquez sur « Scanner GLPI » pour récupérer la liste depuis votre instance.",
                    "Click “Scan GLPI” to fetch the list from your instance.",
                  )
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <PanelHead
            title={title}
            subtitle={
              // Compteur annoncé : cocher une case ne change rien d'autre à l'écran, et
              // filtrer non plus — sans `aria-live`, l'effet de l'action reste invisible
              // pour un lecteur d'écran.
              <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                {t(
                  `${eligibleCount} éligible(s) · ${filtered.length}/${items.length} affiché(s)`,
                  `${eligibleCount} eligible · ${filtered.length}/${items.length} shown`,
                )}
              </span>
            }
            right={
              filtered.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={basculerAffiches}>
                  {tousAffichesCoches ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <CheckSquare className="h-3.5 w-3.5" />
                  )}
                  {tousAffichesCoches
                    ? t(
                        `Décocher les ${filtered.length} affichés`,
                        `Untick the ${filtered.length} shown`,
                      )
                    : t(
                        `Cocher les ${filtered.length} affichés`,
                        `Tick the ${filtered.length} shown`,
                      )}
                </Button>
              ) : undefined
            }
          />
          {/* Barre d'outils */}
          <div
            className={cn(
              "flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-3",
              SUBSURFACE,
            )}
          >
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                aria-label={
                  kind === "technician"
                    ? t("Rechercher un technicien", "Search a technician")
                    : t("Rechercher un groupe", "Search a group")
                }
                placeholder={t("Rechercher par nom ou ID…", "Search by name or ID…")}
                className="pl-9"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {profiles.length > 0 && (
              <Select
                aria-label={t("Filtrer par profil GLPI", "Filter by GLPI profile")}
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className="w-auto"
              >
                <option value={ALL}>{t("Tous les profils", "All profiles")}</option>
                {profiles.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            )}
            <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-card px-3 text-ui text-muted-foreground">
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
                    "px-5 py-3 transition-colors",
                    i < filtered.length - 1 && "border-b border-border",
                    d.eligible ? SELECTED_ROW : "hover:bg-accent/40",
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
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-caption font-semibold transition-colors",
                          d.eligible
                            ? "bg-primary/15 text-accent-indigo"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {initials(r.name)}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-ui font-medium">
                          {r.name}{" "}
                          <span className="font-mono text-caption text-muted-foreground">
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
                    {rowExtra?.(r, d.eligible)}
                  </div>
                  {d.eligible && catalog.length > 0 && (
                    <div className="mt-3 pl-[44px]">
                      <p className="mb-1.5 text-caption text-muted-foreground">
                        {/* Le même éditeur sert les techniciens ET les groupes : la phrase
                            disait « ce technicien » sur /groups. */}
                        {kind === "technician"
                          ? t(
                              "Domaines pris en charge — cochez pour décrire ce technicien sans rien rédiger.",
                              "Supported domains — tick to describe this technician without writing anything.",
                            )
                          : t(
                              "Domaines pris en charge — cochez pour décrire ce groupe sans rien rédiger.",
                              "Supported domains — tick to describe this group without writing anything.",
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
                                "rounded-full border px-2.5 py-1 text-caption transition-colors",
                                coche
                                  ? SELECTED_CONTROL
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
                        // Plus « disponibilités » : les congés ont leur outil dédié
                        // (AbsencePlanner), les écrire ici ne serait lu par personne.
                        placeholder={t(
                          "Précisions libres — exceptions, spécialités, exclusions…",
                          "Free-form notes — exceptions, specialties, exclusions…",
                        )}
                        onChange={(e) => patch(r.ext_id, { skills: e.target.value })}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <EmptyState
                dense
                icon={SearchX}
                title={t("Aucun résultat pour ce filtre.", "No result for this filter.")}
              />
            )}
          </div>
        </Card>
      )}
      {/* Barre d'enregistrement COLLANTE : le bouton vivait sous soixante fiches dépliées,
          on cochait, on quittait la page, on perdait tout sans le moindre avertissement.
          Elle porte aussi le compteur — la seule trace visible de ce qui n'est pas encore
          parti au serveur. Même gabarit que celle d'EngineSettings. */}
      {items.length > 0 && (
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
                "text-body",
                modifies > 0 ? "font-medium text-warning" : "text-muted-foreground",
              )}
            >
              {modifies > 0
                ? t(
                    `${modifies} modification(s) non enregistrée(s)`,
                    `${modifies} unsaved change(s)`,
                  )
                : t("Aucune modification en attente", "No pending change")}
            </p>
            <Button onClick={onSave} disabled={saving || modifies === 0}>
              {saving
                ? t("Enregistrement…", "Saving…")
                : t("Enregistrer la sélection", "Save selection")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
