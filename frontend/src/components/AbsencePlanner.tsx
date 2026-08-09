import { CalendarOff, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { type AbsenceItem, type AbsenceView, Api, type RefItem } from "@/lib/api";
import { useT } from "@/lib/i18n";

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

/**
 * Congés et remplaçants.
 *
 * Un technicien absent **sort du périmètre effectif** : le moteur ne le propose plus, donc
 * ne l'assigne plus. Son remplaçant **hérite de ses domaines** dans le prompt — sans quoi
 * le modèle lui attribuerait des tickets qu'il est décrit comme ne couvrant pas, avec une
 * confiance basse, et le seuil les renverrait « à trier ».
 *
 * L'absence **expire d'elle-même** : rien à réactiver le lundi matin.
 */
export function AbsencePlanner() {
  const t = useT();
  const toast = useToast();
  const res = useResource(useCallback(() => Api.absences(), []));
  const techs = useResource(useCallback(() => Api.discovery("technician"), []));
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [saving, setSaving] = useState(false);
  // Clé locale des nouvelles lignes : négative pour ne jamais heurter un id serveur.
  const [prochainId, setProchainId] = useState(-1);

  useEffect(() => {
    if (res.data) setLignes(res.data.map(versLigne));
  }, [res.data]);

  const eligibles: RefItem[] = (techs.data ?? []).filter((x) => x.eligible);
  const actives = new Set((res.data ?? []).filter((a) => a.active).map((a) => a.id));

  function patch(id: number, p: Partial<Ligne>) {
    setLignes((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }

  function ajouter() {
    const premier = eligibles[0]?.ext_id ?? 0;
    setLignes((l) => [
      ...l,
      {
        id: prochainId,
        technician_ext_id: premier,
        start_date: aujourdhui(),
        end_date: aujourdhui(),
        replacement_ext_id: null,
        note: "",
      },
    ]);
    setProchainId((n) => n - 1);
  }

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
    <Card className="overflow-hidden">
      <PanelHead
        title={t("Congés & remplaçants", "Time off & stand-ins")}
        subtitle={t(
          "Un technicien absent sort du périmètre : il n'est plus proposé. Son remplaçant hérite de ses domaines. L'absence expire d'elle-même.",
          "An absent technician leaves the scope: they are no longer proposed. Their stand-in inherits their domains. The absence expires on its own.",
        )}
        right={
          <Button variant="ghost" size="sm" onClick={ajouter}>
            <Plus className="h-3.5 w-3.5" />
            {t("Ajouter", "Add")}
          </Button>
        }
      />

      {lignes.length === 0 ? (
        <p className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
          {t("Aucune absence déclarée.", "No absence declared.")}
        </p>
      ) : (
        <div className="flex flex-col">
          {lignes.map((l) => (
            <div
              key={l.id}
              className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 last:border-b-0"
            >
              <CalendarOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <select
                aria-label={t("Technicien absent", "Absent technician")}
                value={l.technician_ext_id}
                onChange={(e) => patch(l.id, { technician_ext_id: Number(e.target.value) })}
                className="h-8 rounded-md border border-input bg-card px-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {eligibles.map((x) => (
                  <option key={x.ext_id} value={x.ext_id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <Input
                type="date"
                aria-label={t("Du", "From")}
                value={l.start_date}
                onChange={(e) => patch(l.id, { start_date: e.target.value })}
                className="h-8 w-36 text-[12px]"
              />
              <span className="text-[12px] text-muted-foreground">{t("au", "to")}</span>
              <Input
                type="date"
                aria-label={t("Au (inclus)", "To (inclusive)")}
                title={t("Dernier jour d'absence INCLUS", "Last day of absence, INCLUSIVE")}
                value={l.end_date}
                onChange={(e) => patch(l.id, { end_date: e.target.value })}
                className="h-8 w-36 text-[12px]"
              />
              <select
                aria-label={t("Remplaçant", "Stand-in")}
                title={t(
                  "Le remplaçant hérite des domaines de l'absent dans le prompt de routage.",
                  "The stand-in inherits the absent person's domains in the routing prompt.",
                )}
                value={l.replacement_ext_id ?? ""}
                onChange={(e) =>
                  patch(l.id, {
                    replacement_ext_id: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                className="h-8 rounded-md border border-input bg-card px-2 text-[12px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <option value="">{t("Sans remplaçant", "No stand-in")}</option>
                {eligibles
                  .filter((x) => x.ext_id !== l.technician_ext_id)
                  .map((x) => (
                    <option key={x.ext_id} value={x.ext_id}>
                      {x.name}
                    </option>
                  ))}
              </select>
              {actives.has(l.id) && <Tag tone="amber">{t("En cours", "Ongoing")}</Tag>}
              <button
                type="button"
                aria-label={t("Supprimer cette absence", "Delete this absence")}
                onClick={() => setLignes((all) => all.filter((x) => x.id !== l.id))}
                className="ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-border bg-muted/30 px-4 py-3">
        <Button onClick={enregistrer} disabled={saving} size="sm">
          {saving
            ? t("Enregistrement…", "Saving…")
            : t("Enregistrer les absences", "Save absences")}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {t(
            "Dates incluses, évaluées dans le fuseau configuré du moteur.",
            "Dates are inclusive, evaluated in the engine's configured time zone.",
          )}
        </span>
      </div>

      {lignes.some((l) => l.end_date < l.start_date) && (
        <div className="px-4 pb-3">
          <Banner kind="warning">
            {t(
              "Une période se termine avant son début — l'enregistrement sera refusé.",
              "A period ends before it starts — saving will be rejected.",
            )}
          </Banner>
        </div>
      )}
    </Card>
  );
}
