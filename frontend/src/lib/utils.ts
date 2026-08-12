import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Fusion conditionnelle de classes Tailwind. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Recettes d'état partagées — trois manières de peindre « ceci est sélectionné » et trois
 * nuances de sous-surface cohabitaient, sans qu'aucune différence ne veuille dire quoi que
 * ce soit. Deux états suffisent, et ils sont nommés ici pour ne plus diverger.
 */

/** Ligne cochée dans une liste : teinte à peine posée, le texte reste le sujet. */
export const SELECTED_ROW = "bg-primary/[0.04]";

/** Contrôle actif (onglet, puce, carte de choix, entrée de navigation) : teinte assumée. */
export const SELECTED_CONTROL = "border-primary/40 bg-primary/15 text-accent-indigo";

/** Sous-surface d'une carte : barre d'outils, encart, bloc de code. Une seule nuance. */
export const SUBSURFACE = "bg-muted/30";
