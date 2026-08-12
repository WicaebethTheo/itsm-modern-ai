import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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
  role,
  children,
}: {
  kind: "success" | "error" | "warning" | "info";
  /**
   * Restitution : `alert` pour une erreur qui doit interrompre un lecteur d'écran,
   * `status` pour une information qui arrive sans urgence. Absent = purement visuel
   * (le conteneur `aria-live` de la page s'en charge déjà, le plus souvent).
   */
  role?: "alert" | "status";
  children: ReactNode;
}) {
  return (
    <div role={role} className={cn("rounded-md border px-3 py-2 text-body", bannerStyles[kind])}>
      {children}
    </div>
  );
}
