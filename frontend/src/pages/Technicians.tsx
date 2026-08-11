import { useCallback, useState } from "react";
import { AbsencePlanner, AbsenceRowStatus } from "@/components/AbsencePlanner";
import { RefEligibilityEditor } from "@/components/RefEligibilityEditor";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";

/**
 * Techniciens : qui est éligible, ce qu'il couvre — et s'il est là.
 *
 * La disponibilité de l'équipe est EN HAUT, pas empilée sous quarante fiches : « qui est
 * absent en ce moment » est une question qu'on se pose en arrivant, pas une table qu'on
 * découvre en faisant défiler. Et l'action, elle, reste au plus près de la personne : chaque
 * ligne de technicien porte son état d'absence et un bouton qui ouvre SA ligne dans la
 * planification.
 *
 * La page tient la liste des absences pour les deux : la carte l'édite, les lignes
 * l'affichent. Un `reload` après enregistrement resynchronise les pastilles.
 */
export function Technicians() {
  const abs = useResource(useCallback(() => Api.absences(), []));
  // Technicien dont on vient de demander l'absence depuis sa ligne. Remis à null dès que la
  // carte a consommé la demande, sinon un second clic sur le même nom ne ferait rien.
  const [cible, setCible] = useState<number | null>(null);
  const focusConsomme = useCallback(() => setCible(null), []);
  const absences = abs.data ?? [];

  return (
    <div className="space-y-4">
      <AbsencePlanner focusTechId={cible} onFocusHandled={focusConsomme} onSaved={abs.reload} />
      <RefEligibilityEditor
        kind="technician"
        save={Api.saveTechnicians}
        rowExtra={(tech, eligible) =>
          // Un non-éligible n'est pas dans le pool de routage : il n'y a rien à en retirer.
          eligible ? (
            <AbsenceRowStatus tech={tech} absences={absences} onDeclare={setCible} />
          ) : null
        }
      />
    </div>
  );
}
