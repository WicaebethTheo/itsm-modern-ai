import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

// Le titre de la vue vit dans la topbar (dérivé de la route, cf. lib/nav).
// Ce module n'expose plus que la bannière d'alerte inline.

const bannerStyles = {
  success: "border-success/30 bg-success/10 text-success",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-primary/25 bg-primary/10 text-primary",
} as const;

export function Banner({
  kind,
  children,
}: {
  kind: "success" | "error" | "warning" | "info";
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-md border px-3 py-2 text-[12.5px]", bannerStyles[kind])}>
      {children}
    </div>
  );
}
