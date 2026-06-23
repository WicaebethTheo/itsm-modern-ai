import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type TagTone = "green" | "indigo" | "purple" | "amber" | "red" | "muted";

// Statuts = fond translucide + texte plein (spec § statuts).
const toneClass: Record<TagTone, string> = {
  green: "bg-success/12 text-success",
  indigo: "bg-primary/15 text-accent-indigo",
  purple: "bg-accent-purple/12 text-accent-purple",
  amber: "bg-warning/15 text-warning",
  red: "bg-destructive/12 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

/** Tag / pill — étiquette de statut (spec : `rounded` 4px, 11px, bg translucide + fg). */
export function Tag({
  tone = "indigo",
  children,
  className,
}: {
  tone?: TagTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium",
        toneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
