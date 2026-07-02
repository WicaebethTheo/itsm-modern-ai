import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * PanelHead — en-tête de Panel (spec Operator Preview) : titre 13px + sous-titre 11px
 * à gauche, slot `right` (bouton/badge/compteur) à droite, bordure basse.
 * À placer en première ligne d'une <Card>. Le contenu suit dans <CardContent>.
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
        "flex items-center justify-between gap-3 border-b border-border px-4 py-2.5",
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="truncate text-[13px] font-medium leading-tight">{title}</h3>
        {subtitle && (
          <p className="truncate text-[11px] leading-tight text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}
