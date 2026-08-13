import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Liste déroulante — un `<select>` NATIF habillé, jamais une liste maison.
 *
 * C'est un choix, pas un raccourci : le natif apporte gratuitement le clavier, le focus, la
 * restitution mobile et les lecteurs d'écran, il ne coûte aucune dépendance (le produit tourne
 * hors-ligne), et les `<option>` restent inspectables. La chaîne de classes est celle de
 * `input.tsx` : un select et un champ texte côte à côte doivent avoir la même géométrie.
 *
 * Densité : passer `className="h-8 w-auto"` pour les lignes serrées (tableaux), comme le font
 * déjà les `Input` de la planification d'absences.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-ui shadow-sm transition-colors hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";
