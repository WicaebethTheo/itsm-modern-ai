import { cn } from "@/lib/utils";
import { useState } from "react";

/** Calcule les initiales (1 à 2 lettres) d'un nom affichable. "?" si vide. */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export interface AvatarProps {
  /** Nom affichable, sert au calcul des initiales du fallback. */
  name: string | null | undefined;
  /** URL de la photo. Absente => directement le fallback initiales. */
  src?: string | null;
  /** Texte alternatif de l'image. */
  alt?: string;
  className?: string;
}

/**
 * Avatar rond : photo si `src` fournie (bascule sur initiales en cas d'erreur de
 * chargement), sinon cercle dégradé teinte primaire avec initiales.
 */
export function Avatar({ name, src, alt, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImg = !!src && !failed;

  return (
    <span
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full",
        "bg-gradient-to-br from-primary/25 to-primary/10 text-[13px] font-semibold text-primary",
        "ring-1 ring-border",
        className,
      )}
    >
      {showImg ? (
        <img
          src={src ?? undefined}
          alt={alt ?? name ?? ""}
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden>{initials(name)}</span>
      )}
    </span>
  );
}
