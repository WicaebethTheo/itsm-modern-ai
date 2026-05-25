import { RefEligibilityEditor } from "@/components/RefEligibilityEditor";
import { Api } from "@/lib/api";

export function Technicians() {
  return (
    <RefEligibilityEditor
      kind="technician"
      title="Techniciens"
      description="Scannés depuis GLPI. Cochez ceux vers qui l'IA peut router et décrivez leurs compétences."
      save={Api.saveTechnicians}
    />
  );
}
