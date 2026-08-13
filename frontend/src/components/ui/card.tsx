import type * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

/**
 * Corps de carte. La gouttière (`p-5`) est celle qu'utilisaient DÉJÀ tous les appelants :
 * le défaut historique (`p-5 pt-3`) n'était employé nulle part et se faisait annuler à la
 * main partout. `PanelHead` s'aligne sur la même gouttière, sans quoi chaque titre de carte
 * était décalé de 4 px par rapport à son contenu.
 *
 * (`CardHeader` / `CardTitle` ont été retirés : zéro usage, `PanelHead` les remplace.)
 */
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}
