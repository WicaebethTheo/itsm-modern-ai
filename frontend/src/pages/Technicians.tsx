import { AbsencePlanner } from "@/components/AbsencePlanner";
import { RefEligibilityEditor } from "@/components/RefEligibilityEditor";
import { Api } from "@/lib/api";

export function Technicians() {
  return (
    <div className="space-y-4">
      <RefEligibilityEditor kind="technician" save={Api.saveTechnicians} />
      {/* Les congés vivent avec la liste des techniciens : c'est le même écran qui rend
          visible le risque « un seul acteur sur ce domaine » (carte de couverture). */}
      <AbsencePlanner />
    </div>
  );
}
