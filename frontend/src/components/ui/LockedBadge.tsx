import { Tag } from "@/components/ui/tag";
import { useT } from "@/lib/i18n";
import { Lock } from "lucide-react";

/**
 * Petit badge « Supporter » verrouillé — signale une fonctionnalité non débloquée
 * (édition Community ou licence sans droit). Réutilisé dans la page Store.
 */
export function LockedBadge() {
  const t = useT();
  return (
    <Tag tone="purple">
      <Lock className="h-3 w-3" />
      {t("Supporter", "Supporter")}
    </Tag>
  );
}
