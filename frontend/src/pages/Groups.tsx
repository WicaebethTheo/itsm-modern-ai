import { RefEligibilityEditor } from "@/components/RefEligibilityEditor";
import { Api } from "@/lib/api";

export function Groups() {
  return <RefEligibilityEditor kind="group" save={Api.saveGroups} />;
}
