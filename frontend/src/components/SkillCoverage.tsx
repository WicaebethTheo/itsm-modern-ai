import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Banner } from "@/components/Banner";
import { Api, type RefKind, type SkillCoverage } from "@/lib/api";
import { useLang, useT } from "@/lib/i18n";

/**
 * Carte de couverture des domaines — transforme une page de cases à cocher en
 * DIAGNOSTIC PRÉDICTIF.
 *
 * Ce que l'admin voyait jusqu'ici : une liste de techniciens et des puces à cocher, sans
 * aucun retour sur ce que sa sélection produit. Il découvrait le trou dans le Journal,
 * trois semaines plus tard, sous forme de tickets « à trier ». Ce bandeau nomme la panne
 * AVANT qu'elle arrive, sur l'écran même où elle se corrige :
 *
 * - **domaine sans aucun acteur** → routage impossible, « à trier » garanti dès qu'un
 *   ticket en relève ;
 * - **domaine tenu par un seul technicien, sans groupe** → point de défaillance unique :
 *   le domaine tombe le jour de son congé. Un groupe, lui, encaisse l'absence.
 *
 * Le compteur du type EN COURS D'ÉDITION vient du brouillon local, pas du serveur : sinon
 * le bandeau contredirait les cases que l'admin vient de cocher. Le type non édité vient
 * du serveur — il ne peut pas changer depuis cette page.
 */
export function SkillCoverageBanner({
  kind,
  live,
}: {
  kind: RefKind;
  /** Nombre d'acteurs éligibles par domaine dans le brouillon courant (type édité). */
  live: Record<string, number>;
}) {
  const t = useT();
  const { lang } = useLang();
  const [coverage, setCoverage] = useState<SkillCoverage[] | null>(null);

  // Échec NON bloquant, comme le catalogue : on n'ampute pas la page de configuration
  // parce qu'un diagnostic n'a pas pu se charger.
  useEffect(() => {
    let vivant = true;
    Api.skillCoverage()
      .then((c) => vivant && setCoverage(c))
      .catch(() => undefined);
    return () => {
      vivant = false;
    };
  }, []);

  const { orphelins, fragiles } = useMemo(() => {
    const orphelins: string[] = [];
    const fragiles: string[] = [];
    for (const d of coverage ?? []) {
      const techniciens = kind === "technician" ? (live[d.key] ?? 0) : d.technicians;
      const groupes = kind === "group" ? (live[d.key] ?? 0) : d.groups;
      const label = lang === "fr" ? d.label_fr : d.label_en;
      if (techniciens + groupes === 0) orphelins.push(label);
      else if (techniciens === 1 && groupes === 0) fragiles.push(label);
    }
    return { orphelins, fragiles };
  }, [coverage, kind, live, lang]);

  if (coverage === null) return null;

  if (orphelins.length === 0 && fragiles.length === 0) {
    return (
      <Banner kind="success">
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          {t(
            `Les ${coverage.length} domaines sont couverts, aucun par une seule personne.`,
            `All ${coverage.length} domains are covered, none by a single person.`,
          )}
        </span>
      </Banner>
    );
  }

  return (
    <div className="space-y-2">
      {orphelins.length > 0 && (
        <Banner kind="warning">
          <span className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>
                {t(
                  `Aucun acteur sur ${orphelins.length} domaine(s)`,
                  `No one covers ${orphelins.length} domain(s)`,
                )}
              </strong>{" "}
              — {orphelins.join(", ")}.{" "}
              {t(
                "Tout ticket qui en relève partira « à trier ».",
                "Any ticket in these domains will end up “to sort”.",
              )}
            </span>
          </span>
        </Banner>
      )}
      {fragiles.length > 0 && (
        <Banner kind="info">
          <span className="flex items-start gap-1.5">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>
                {t(
                  `Une seule personne sur ${fragiles.length} domaine(s)`,
                  `A single person covers ${fragiles.length} domain(s)`,
                )}
              </strong>{" "}
              — {fragiles.join(", ")}.{" "}
              {t(
                "Le jour de son absence, le domaine n'est plus couvert : un groupe éligible sert de filet.",
                "The day they are away, the domain is uncovered: an eligible group acts as a safety net.",
              )}
            </span>
          </span>
        </Banner>
      )}
    </div>
  );
}
