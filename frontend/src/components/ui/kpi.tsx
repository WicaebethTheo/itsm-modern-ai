import type * as React from "react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Indicateur chiffré — la SEULE recette de « grand nombre + libellé » de la console.
 *
 * Elle en remplace trois, visuellement identiques mais aux API divergentes (une par page,
 * plus une variante posée en ligne dans une grille). `variant="cell"` rend une cellule sans
 * bordure, pour les grilles `gap-px` qui simulent un tableau : même typographie, même
 * rythme vertical, seul le châssis change.
 *
 * `loading` rend un squelette : un « — » muet est indiscernable d'une valeur nulle
 * réellement mesurée, et c'est la première chose que voit l'exploitant en arrivant.
 */
export function KpiCard({
  icon,
  label,
  value,
  tag,
  tagClass = "text-muted-foreground",
  hint,
  loading = false,
  variant = "card",
  children,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  /** Petite mention à droite de la valeur (part, plafond…). */
  tag?: string;
  tagClass?: string;
  /** Précision sous la valeur. */
  hint?: string;
  loading?: boolean;
  variant?: "card" | "cell";
  children?: ReactNode;
}) {
  const t = useT();
  const contenu = (
    <>
      <div className="flex items-center gap-2 text-caption text-muted-foreground">
        {icon && <span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>}
        {label}
      </div>
      {loading ? (
        <>
          <div className="mt-1.5 flex h-[26px] items-center">
            <span className="block h-[18px] w-20 animate-pulse rounded bg-muted" aria-hidden />
            <span className="sr-only">{t("Chargement…", "Loading…")}</span>
          </div>
          <span className="mt-2 block h-4 w-full animate-pulse rounded bg-muted" aria-hidden />
        </>
      ) : (
        <>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-hero font-semibold tracking-tight">{value}</span>
            {tag && <span className={cn("text-caption", tagClass)}>{tag}</span>}
          </div>
          {hint && <div className="mt-0.5 text-caption text-muted-foreground">{hint}</div>}
          {children}
        </>
      )}
    </>
  );

  if (variant === "cell") return <div className="bg-card p-5">{contenu}</div>;
  return <Card className="p-4">{contenu}</Card>;
}

/** Carte KPI encore vide : mêmes dimensions, pour éviter le saut de mise en page. */
export function KpiSkeleton(props: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Card className="p-4" {...props}>
      <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      <div className="mt-2 h-6 w-20 animate-pulse rounded bg-muted" />
      <div className="mt-2 h-2.5 w-28 animate-pulse rounded bg-muted" />
    </Card>
  );
}
