import { RefEligibilityEditor } from "@/components/RefEligibilityEditor";
import { Api } from "@/lib/api";

export function Technicians() {
  return <RefEligibilityEditor kind="technician" save={Api.saveTechnicians} />;
}
