import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * PanelHead — en-tête de Panel (spec Operator Preview) : titre 13px + sous-titre 11px
 * à gauche, slot `right` (bouton/badge/compteur) à droite, bordure basse.
 * À placer en première ligne d'une <Card>. Le contenu suit dans <CardContent>.
 *
 * Gouttière `px-5` : la même que `CardContent` et que les lignes de contenu des cartes,
 * pour que le titre s'aligne sur ce qu'il annonce.
 */
export function PanelHead({
  title,
  subtitle,
  right,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border px-5 py-2.5",
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="truncate text-ui font-medium leading-tight">{title}</h3>
        {subtitle && (
          <p className="truncate text-caption leading-tight text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}
