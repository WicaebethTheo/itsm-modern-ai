import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * `twMerge` doit connaître NOS jetons de taille, sinon il les détruit en silence.
 *
 * `text-*` est ambigu par nature : c'est la couleur ET la taille du texte. `tailwind-merge`
 * tranche sur une liste de tailles connues (`sm`, `lg`, `[13px]`…) et range tout le reste
 * dans les couleurs. Nos jetons `@theme` (`--text-ui`, `--text-caption`…) lui étant
 * inconnus, il les prenait pour des couleurs et les supprimait dès qu'une vraie couleur
 * figurait dans la même chaîne — c'est-à-dire dans presque toute la couche UI :
 *
 *     twMerge("text-ui font-medium text-foreground")  →  "font-medium text-foreground"
 *
 * Les tags, bannières, toasts et libellés retombaient donc à la taille héritée (16 px au
 * lieu de 11 à 13), et un `Button size="sm"` perdait sa couleur de texte au profit du
 * jeton de taille, jusqu'à 2,1:1 de contraste en thème clair. Rien ne le voyait : les
 * classes sont absentes du DOM, pas fausses, et aucun test n'assère de classe.
 *
 * Les anciennes valeurs arbitraires (`text-[13px]`) ne souffraient pas du problème — c'est
 * donc bien le passage aux jetons nommés qui l'a introduit. Le test de `utils.test.ts` fige
 * la règle : tout nouveau jeton de taille doit être déclaré ici.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "body", "ui", "title", "metric", "hero"] }],
    },
  },
});

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
