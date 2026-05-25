import { RefEligibilityEditor } from "@/components/RefEligibilityEditor";
import { Api } from "@/lib/api";

export function Groups() {
  return (
    <RefEligibilityEditor
      kind="group"
      title="Groupes"
      description="Cibles de repli quand aucun technicien précis ne convient. Cochez les groupes éligibles et décrivez-les."
      save={Api.saveGroups}
    />
  );
}
