import {
  AlertTriangle,
  CalendarOff,
  CalendarPlus,
  ChevronDown,
  ChevronUp,
  MoveRight,
  Plus,
  Trash2,
  UserCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/Banner";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PanelHead } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import {
  type AbsenceItem,
  type AbsenceView,
  Api,
  type RefItem,
  type SkillCoverage,
} from "@/lib/api";
import { type Lang, localeFor, useLang, useT } from "@/lib/i18n";
import { cn, SUBSURFACE } from "@/lib/utils";

/** Brouillon local d'une ligne — `id` sert de clé React, il n'est pas renvoyé au serveur. */
type Ligne = AbsenceItem & { id: number };

function versLigne(a: AbsenceView): Ligne {
  return {
    id: a.id,
    technician_ext_id: a.technician_ext_id,
    start_date: a.start_date,
    end_date: a.end_date,
    replacement_ext_id: a.replacement_ext_id ?? null,
    note: a.note ?? "",
  };
}

function aujourdhui(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Ligne vierge pour un technicien. `id` local (négatif) : il ne heurte aucun id serveur. */
function nouvelleLigne(id: number, techId: number): Ligne {
  return {
    id,
    technician_ext_id: techId,
    start_date: aujourdhui(),
    end_date: aujourdhui(),
    replacement_ext_id: null,
    note: "",
  };
}

/**
 * Jour ISO rendu lisible. `timeZone: "UTC"` est explicite : sans lui, un poste à l'ouest de
 * Greenwich afficherait la veille d'une borne qui, elle, est un JOUR (pas un instant).
 * L'autorité sur « sommes-nous dans la période ? » reste le serveur (`active`), qui évalue
 * dans le fuseau configuré du moteur — on n'affiche ici qu'une étiquette.
 */
function formatJour(iso: string, lang: Lang): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(localeFor(lang), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * Absence PAS ENCORE ACTIVE mais PAS TERMINÉE — le test qui ne laisse aucun trou.
 *
 * Le serveur tranche `active` dans le fuseau configuré du MOTEUR ; `aujourdhui()` est une
 * date UTC. Les deux divergent plusieurs heures par jour sur tout déploiement à offset
 * négatif. Tester « commence après aujourd'hui » ouvrait alors une fenêtre où une absence
 * n'était NI active (le serveur n'y est pas encore) NI à venir (sa date de début n'est plus
 * postérieure à la date UTC) : invisible du résumé et de la ligne du technicien, sur la
 * seule vue de planification — une absence d'un seul jour pouvait n'apparaître nulle part.
 * On borne donc par la FIN : tant qu'elle n'est pas passée, l'absence reste annoncée.
 */
function pasEncoreTerminee(a: AbsenceView, jour: string): boolean {
  return !a.active && a.end_date >= jour;
}

/** L'absence qui concerne ce technicien : celle en cours, sinon la prochaine déclarée. */
export function absenceDuTechnicien(absences: AbsenceView[], extId: number): AbsenceView | null {
  const siennes = absences.filter((a) => a.technician_ext_id === extId);
  const jour = aujourdhui();
  return (
    siennes.find((a) => a.active) ??
    siennes
      .filter((a) => pasEncoreTerminee(a, jour))
      .sort((a, b) => a.start_date.localeCompare(b.start_date))[0] ??
    null
  );
}

/**
 * Domaines qui perdent leur DERNIER acteur à cause des absences fournies.
 *
 * C'est le croisement qui donne son sens à la fonctionnalité : la carte de couverture
 * (`SkillCoverage`) dit qui tient quoi *en théorie* ; ici on retire les absents et on
 * ajoute les remplaçants — qui **héritent des domaines** de l'absent, exactement comme
 * `interim_context` le fait dans le prompt — pour dire ce qui tombe *en pratique*.
 *
 * Deux exclusions volontaires, pour ne pas crier deux fois la même chose :
 * - un domaine que PERSONNE ne tenait déjà est un trou structurel, déjà nommé par la carte
 *   de couverture ; ce n'est pas l'absence qui l'a créé ;
 * - un domaine couvert par un groupe éligible encaisse l'absence sans configuration.
 *
 * On n'appelle jamais cette fonction sur des absences qui ne se recouvrent pas : soit sur
 * les absences ACTIVES (elles couvrent toutes la journée en cours, par construction), soit
 * sur UNE seule ligne en cours d'édition. Additionner deux congés disjoints inventerait
 * une panne qui n'arrivera jamais.
 */
export function domainesPerdus(
  absences: Pick<AbsenceItem, "technician_ext_id" | "replacement_ext_id">[],
  eligibles: RefItem[],
  coverage: SkillCoverage[],
  lang: Lang,
): string[] {
  if (absences.length === 0) return [];
  const absents = new Set(absences.map((a) => a.technician_ext_id));
  const parId = new Map(eligibles.map((e) => [e.ext_id, e]));
  const perdus: string[] = [];

  for (const dom of coverage) {
    if (dom.groups > 0) continue; // un groupe éligible sert de filet
    const porteurs = eligibles.filter((e) => (e.skill_tags ?? []).includes(dom.key));
    if (porteurs.length === 0) continue; // trou structurel, pas un effet de l'absence
    if (porteurs.some((p) => !absents.has(p.ext_id))) continue; // il reste quelqu'un

    // Reste les remplaçants. Un remplaçant lui-même absent ne remplace personne (le moteur
    // ne fait qu'UN saut : cf. `interim_context`), et un non-éligible n'est pas dans le pool.
    const releve = absences.some((a) => {
      const r = a.replacement_ext_id;
      if (r == null || absents.has(r) || !parId.has(r)) return false;
      return porteurs.some((p) => p.ext_id === a.technician_ext_id);
    });
    if (!releve) perdus.push(lang === "fr" ? dom.label_fr : dom.label_en);
  }
  return perdus;
}

/**
 * État d'absence porté par la LIGNE du technicien, dans la liste d'éligibilité.
 *
 * Une absence n'est pas un objet indépendant : c'est un attribut d'une personne. On la lit
 * et on la déclare là où l'on voit cette personne, pas dans une table reléguée en bas de
 * page qu'il fallait découvrir en faisant défiler quarante fiches.
 */
export function AbsenceRowStatus({
  tech,
  absences,
  onDeclare,
}: {
  tech: RefItem;
  absences: AbsenceView[];
  onDeclare: (extId: number) => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const absence = absenceDuTechnicien(absences, tech.ext_id);
  const remplacant = absence?.replacement_name?.trim() ?? "";

  return (
    <>
      {absence &&
        (absence.active ? (
          <Tag tone="amber">
            <CalendarOff className="h-3 w-3" />
            {t(
              `Absent jusqu'au ${formatJour(absence.end_date, lang)}`,
              `Away until ${formatJour(absence.end_date, lang)}`,
            )}
            {remplacant
              ? ` · ${t(`remplacé par ${remplacant}`, `covered by ${remplacant}`)}`
              : ` · ${t("sans remplaçant", "no stand-in")}`}
          </Tag>
        ) : (
          <Tag tone="muted">
            <CalendarOff className="h-3 w-3" />
            {t(
              `Absent à partir du ${formatJour(absence.start_date, lang)}`,
              `Away from ${formatJour(absence.start_date, lang)}`,
            )}
          </Tag>
        ))}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => onDeclare(tech.ext_id)}
        aria-label={
          absence
            ? t(`Modifier l'absence de ${tech.name}`, `Edit ${tech.name}'s time off`)
            : t(`Déclarer une absence pour ${tech.name}`, `Declare time off for ${tech.name}`)
        }
        title={t("Congés & remplaçant", "Time off & stand-in")}
        className="text-muted-foreground hover:text-foreground"
      >
        <CalendarPlus />
      </Button>
    </>
  );
}

/** Pastille de résumé : une personne absente aujourd'hui, sa fin de congé, son remplaçant. */
function PastilleAbsent({ a }: { a: AbsenceView }) {
  const t = useT();
  const { lang } = useLang();
  const remplacant = a.replacement_name?.trim() ?? "";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-body">
      <CalendarOff className="h-3.5 w-3.5 shrink-0 text-warning" />
      <span className="font-medium">{a.technician_name}</span>
      <span className="text-muted-foreground">
        {t(`jusqu'au ${formatJour(a.end_date, lang)}`, `until ${formatJour(a.end_date, lang)}`)}
      </span>
      {remplacant ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <MoveRight className="h-3 w-3 shrink-0" aria-hidden />
          {remplacant}
        </span>
      ) : (
        <Tag tone="amber">{t("sans remplaçant", "no stand-in")}</Tag>
      )}
    </span>
  );
}

export interface AbsencePlannerProps {
  /** Technicien dont on vient de demander l'absence depuis sa ligne (ouvre + focus). */
  focusTechId?: number | null;
  /** Appelé une fois la demande de focus consommée, pour la réarmer. */
  onFocusHandled?: () => void;
  /** Appelé après un enregistrement réussi : la page rafraîchit ses propres pastilles. */
  onSaved?: () => void;
}

/**
 * Congés et remplaçants — disponibilité de l'équipe.
 *
 * Un technicien absent **sort du périmètre effectif** : le moteur ne le propose plus, donc
 * ne l'assigne plus. Son remplaçant **hérite de ses domaines** dans le prompt — sans quoi
 * le modèle lui attribuerait des tickets qu'il est décrit comme ne couvrant pas, avec une
 * confiance basse, et le seuil les renverrait « à trier ».
 *
 * L'absence **expire d'elle-même** : rien à réactiver le lundi matin.
 *
 * La carte s'ouvre sur un RÉSUMÉ (« qui est absent en ce moment »), toujours visible et
 * lisible d'un coup d'œil ; la table éditable, elle, est repliée : c'est un outil de
 * gestion, pas un état à surveiller. La question quotidienne de l'admin n'est pas « quelles
 * absences existent ? » mais « qui est là, et qui couvre les domaines des absents ? ».
 */
export function AbsencePlanner({ focusTechId, onFocusHandled, onSaved }: AbsencePlannerProps) {
  const t = useT();
  const { lang } = useLang();
  const toast = useToast();
  const res = useResource(useCallback(() => Api.absences(), []));
  const techs = useResource(useCallback(() => Api.discovery("technician"), []));
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [saving, setSaving] = useState(false);
  const [ouvert, setOuvert] = useState(false);
  const [aFocaliser, setAFocaliser] = useState<number | null>(null);
  const carte = useRef<HTMLDivElement>(null);
  // Clé locale des nouvelles lignes : négative pour ne jamais heurter un id serveur.
  const prochainId = useRef(-1);
  // Couverture des domaines — chargement NON bloquant, comme partout ailleurs : on n'ampute
  // pas la gestion des congés parce qu'un diagnostic n'a pas pu se charger.
  const [coverage, setCoverage] = useState<SkillCoverage[]>([]);

  useEffect(() => {
    if (res.data) setLignes(res.data.map(versLigne));
  }, [res.data]);

  useEffect(() => {
    let vivant = true;
    Api.skillCoverage()
      .then((c) => vivant && setCoverage(c))
      .catch(() => undefined);
    return () => {
      vivant = false;
    };
  }, []);

  const eligibles: RefItem[] = useMemo(
    () => (techs.data ?? []).filter((x) => x.eligible),
    [techs.data],
  );
  const absences = useMemo(() => res.data ?? [], [res.data]);
  const actives = useMemo(() => absences.filter((a) => a.active), [absences]);
  const activesIds = new Set(actives.map((a) => a.id));
  const aVenir = useMemo(() => {
    const jour = aujourdhui();
    return absences
      .filter((a) => pasEncoreTerminee(a, jour))
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [absences]);

  // Ce que les absences EN COURS coûtent réellement au routage, aujourd'hui.
  const perdusAujourdhui = useMemo(
    () => domainesPerdus(actives, eligibles, coverage, lang),
    [actives, eligibles, coverage, lang],
  );

  function patch(id: number, p: Partial<Ligne>) {
    setLignes((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }

  function ajouter(techId?: number) {
    const ligne = nouvelleLigne(prochainId.current--, techId ?? eligibles[0]?.ext_id ?? 0);
    setLignes((l) => [...l, ligne]);
    setOuvert(true);
    setAFocaliser(ligne.id);
  }

  // Miroir des lignes lisible depuis un effet sans le déclarer en dépendance : l'effet de
  // focus ci-dessous ne doit se rejouer QUE sur une nouvelle demande, jamais parce qu'une
  // date a changé entre-temps.
  const lignesRef = useRef<Ligne[]>([]);
  useEffect(() => {
    lignesRef.current = lignes;
  });

  // Demande venue d'une ligne de technicien : on ouvre la table, on rejoint SA ligne (ou on
  // la crée) et on y emmène le focus — sans ça, l'admin clique au milieu d'une liste de
  // quarante fiches et se retrouve avec le curseur nulle part, devant une table ouverte
  // hors écran.
  useEffect(() => {
    if (focusTechId == null) return;
    setOuvert(true);
    const sienne = lignesRef.current.find((x) => x.technician_ext_id === focusTechId);
    if (sienne) {
      setAFocaliser(sienne.id);
    } else {
      const ligne = nouvelleLigne(prochainId.current--, focusTechId);
      setLignes((l) => [...l, ligne]);
      setAFocaliser(ligne.id);
    }
    // `scrollIntoView` n'existe pas en environnement de test : appel optionnel, pas de garde.
    carte.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    onFocusHandled?.();
  }, [focusTechId, onFocusHandled]);

  async function enregistrer() {
    setSaving(true);
    try {
      await Api.saveAbsences(
        lignes.map(({ id: _id, ...reste }) => ({
          ...reste,
          replacement_ext_id: reste.replacement_ext_id || null,
        })),
      );
      res.reload();
      onSaved?.();
      toast.success(t("Absences enregistrées.", "Absences saved."));
    } catch (e: unknown) {
      // Le serveur REFUSE un remplaçant non éligible ou lui-même absent : son message dit
      // quoi corriger. L'avaler laisserait l'admin croire à un filet qui n'existe pas.
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (eligibles.length === 0) return null; // rien à planifier tant que personne n'est éligible

  return (
    // Le div porte l'ancre de défilement : `Card` ne relaie pas de ref.
    <div ref={carte} className="scroll-mt-4">
      <Card className="overflow-hidden">
        <PanelHead
          title={t("Congés & remplaçants", "Time off & stand-ins")}
          subtitle={t(
            "Un technicien absent sort du périmètre : il n'est plus proposé. Son remplaçant hérite de ses domaines. L'absence expire d'elle-même.",
            "An absent technician leaves the scope: they are no longer proposed. Their stand-in inherits their domains. The absence expires on its own.",
          )}
          right={
            <>
              {lignes.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOuvert((o) => !o)}
                  aria-expanded={ouvert}
                  aria-controls="absences-table"
                >
                  {ouvert ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {ouvert
                    ? t("Masquer", "Hide")
                    : t(
                        `Gérer les absences (${lignes.length})`,
                        `Manage absences (${lignes.length})`,
                      )}
                </Button>
              )}
              <Button size="sm" onClick={() => ajouter()}>
                <Plus className="h-3.5 w-3.5" />
                {t("Déclarer une absence", "Declare time off")}
              </Button>
            </>
          }
        />

        {/* RÉSUMÉ — toujours visible, c'est l'information qu'on vient chercher. */}
        <div className="flex flex-col gap-2 px-5 py-3">
          {actives.length === 0 ? (
            <p className="flex flex-wrap items-center gap-1.5 text-body text-muted-foreground">
              <UserCheck className="h-3.5 w-3.5 shrink-0 text-success" />
              {t(
                "Toute l'équipe est disponible aujourd'hui.",
                "The whole team is available today.",
              )}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body text-muted-foreground">
                {t(
                  `Absent(s) aujourd'hui — ${actives.length} sur ${eligibles.length} :`,
                  `Away today — ${actives.length} of ${eligibles.length}:`,
                )}
              </span>
              {actives.map((a) => (
                <PastilleAbsent key={a.id} a={a} />
              ))}
            </div>
          )}

          {/* Les absences À VENIR, hors du ternaire ci-dessus : elles y étaient enfermées
            dans la branche « personne n'est absent aujourd'hui », donc un seul absent du
            jour masquait toute la semaine à venir — sur la seule vue de planification. */}
          {aVenir.length > 0 && (
            <p className="text-body text-muted-foreground">
              {t(
                `${aVenir.length} absence(s) à venir — prochaine : ${aVenir[0].technician_name}, à partir du ${formatJour(aVenir[0].start_date, lang)}.`,
                `${aVenir.length} upcoming — next: ${aVenir[0].technician_name}, from ${formatJour(aVenir[0].start_date, lang)}.`,
              )}
            </p>
          )}

          {/* Le risque métier que cet écran existe pour rendre visible : un domaine tenu par
            une seule personne, et cette personne est partie. */}
          {perdusAujourdhui.length > 0 && (
            <Banner kind="warning">
              <span className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong>
                    {t(
                      `${perdusAujourdhui.length} domaine(s) sans personne aujourd'hui`,
                      `${perdusAujourdhui.length} domain(s) uncovered today`,
                    )}
                  </strong>{" "}
                  — {perdusAujourdhui.join(", ")}.{" "}
                  {t(
                    "Les tickets qui en relèvent partiront « à trier ». Désignez un remplaçant : il hérite des domaines de l'absent.",
                    "Tickets in these domains will end up “to sort”. Name a stand-in: they inherit the absent person's domains.",
                  )}
                </span>
              </span>
            </Banner>
          )}
        </div>

        {/* TABLE ÉDITABLE — outil de gestion, replié par défaut pour ne pas repousser la
          liste des techniciens de plusieurs écrans sur une instance chargée. */}
        {ouvert && (
          <div id="absences-table" className="border-t border-border">
            {lignes.length === 0 ? (
              <EmptyState dense title={t("Aucune absence déclarée.", "No absence declared.")} />
            ) : (
              <div className="flex flex-col">
                {lignes.map((l) => {
                  const perdusLigne = domainesPerdus([l], eligibles, coverage, lang);
                  return (
                    <div key={l.id} className="border-b border-border px-5 py-3 last:border-b-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <CalendarOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <Select
                          aria-label={t("Technicien absent", "Absent technician")}
                          value={l.technician_ext_id}
                          ref={(el) => {
                            if (el && aFocaliser === l.id) {
                              el.focus();
                              setAFocaliser(null);
                            }
                          }}
                          onChange={(e) =>
                            patch(l.id, { technician_ext_id: Number(e.target.value) })
                          }
                          className="h-8 w-auto px-2"
                        >
                          {eligibles.map((x) => (
                            <option key={x.ext_id} value={x.ext_id}>
                              {x.name}
                            </option>
                          ))}
                        </Select>
                        <Input
                          type="date"
                          aria-label={t("Du", "From")}
                          value={l.start_date}
                          onChange={(e) => patch(l.id, { start_date: e.target.value })}
                          className="h-8 w-36"
                        />
                        <span className="text-body text-muted-foreground">{t("au", "to")}</span>
                        <Input
                          type="date"
                          aria-label={t("Au (inclus)", "To (inclusive)")}
                          title={t(
                            "Dernier jour d'absence INCLUS",
                            "Last day of absence, INCLUSIVE",
                          )}
                          value={l.end_date}
                          onChange={(e) => patch(l.id, { end_date: e.target.value })}
                          className="h-8 w-36"
                        />
                        <Select
                          aria-label={t("Remplaçant", "Stand-in")}
                          title={t(
                            "Le remplaçant hérite des domaines de l'absent dans le prompt de routage.",
                            "The stand-in inherits the absent person's domains in the routing prompt.",
                          )}
                          value={l.replacement_ext_id ?? ""}
                          onChange={(e) =>
                            patch(l.id, {
                              replacement_ext_id:
                                e.target.value === "" ? null : Number(e.target.value),
                            })
                          }
                          className="h-8 w-auto px-2 text-muted-foreground"
                        >
                          <option value="">{t("Sans remplaçant", "No stand-in")}</option>
                          {eligibles
                            .filter((x) => x.ext_id !== l.technician_ext_id)
                            .map((x) => (
                              <option key={x.ext_id} value={x.ext_id}>
                                {x.name}
                              </option>
                            ))}
                        </Select>
                        {activesIds.has(l.id) && <Tag tone="amber">{t("En cours", "Ongoing")}</Tag>}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("Supprimer cette absence", "Delete this absence")}
                          onClick={() => setLignes((all) => all.filter((x) => x.id !== l.id))}
                          className="ml-auto text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      {/* Conséquence de CETTE ligne, calculée seule : elle disparaît dès qu'un
                        remplaçant est désigné, ce qui apprend à quoi sert le champ. */}
                      {perdusLigne.length > 0 && (
                        <p className="mt-2 flex items-start gap-1.5 pl-6 text-caption text-warning">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>
                            {t(
                              `Sans remplaçant, cette absence laisse « ${perdusLigne.join(", ")} » sans personne.`,
                              `With no stand-in, this absence leaves “${perdusLigne.join(", ")}” uncovered.`,
                            )}
                          </span>
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div
              className={cn("flex items-center gap-3 border-t border-border px-5 py-3", SUBSURFACE)}
            >
              <Button onClick={enregistrer} disabled={saving} size="sm">
                {saving
                  ? t("Enregistrement…", "Saving…")
                  : t("Enregistrer les absences", "Save absences")}
              </Button>
              <span className="text-caption text-muted-foreground">
                {t(
                  "Dates incluses, évaluées dans le fuseau configuré du moteur.",
                  "Dates are inclusive, evaluated in the engine's configured time zone.",
                )}
              </span>
            </div>

            {lignes.some((l) => l.end_date < l.start_date) && (
              <div className="px-5 pb-3">
                <Banner kind="warning">
                  {t(
                    "Une période se termine avant son début — l'enregistrement sera refusé.",
                    "A period ends before it starts — saving will be rejected.",
                  )}
                </Banner>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
