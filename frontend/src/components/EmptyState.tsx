import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * État vide / sans données, cohérent sur toutes les pages.
 * À placer typiquement dans un <Card>/<CardContent> ou directement dans une section.
 *
 * <EmptyState
 *   icon={Inbox}
 *   title="Aucune décision enregistrée"
 *   description="Les décisions du moteur apparaîtront ici."
 *   action={<Button size="sm">Configurer</Button>}
 * />
 *
 * `dense` : même composant, gabarit resserré, pour les emplacements où un vide pleine page
 * ferait sauter la mise en page — corps de liste filtrée, ligne de tableau, panneau étroit.
 * C'est ce qui remplace les `<p className="px-4 py-8 text-center …">` réécrits à la main.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  dense = false,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  dense?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        dense ? "gap-1.5 px-4 py-8" : "gap-3 px-6 py-12",
        className,
      )}
    >
      {Icon && (
        <span
          className={cn(
            "flex items-center justify-center rounded-full bg-muted text-muted-foreground",
            dense ? "h-8 w-8" : "h-11 w-11",
          )}
        >
          <Icon className={dense ? "h-4 w-4" : "h-5 w-5"} />
        </span>
      )}
      <div className="space-y-1">
        <p className={cn("font-medium text-foreground", dense ? "text-body" : "text-ui")}>
          {title}
        </p>
        {description && (
          <p
            className={cn(
              "mx-auto max-w-sm text-muted-foreground",
              dense ? "text-body" : "text-ui",
            )}
          >
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
