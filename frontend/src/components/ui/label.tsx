import * as React from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-ui font-medium leading-none text-foreground", className)}
      {...props}
    />
  );
}

/**
 * Éléments HTML qu'un `<label for>` peut réellement désigner. Un `<div>` ou un `<span>`
 * n'en fait pas partie : y pointer ne focaliserait rien et ne nommerait rien.
 */
const LABELABLE = new Set(["input", "select", "textarea", "button", "meter", "output", "progress"]);

/**
 * Un composant (Input, Textarea, Select…) relaie son `id` au contrôle qu'il rend, donc on
 * lui fait confiance ; une balise intrinsèque doit être dans la liste ci-dessus.
 * Le paramètre est volontairement large : `ReactElement.type` vaut `string` OU un
 * constructeur de composant, et le restreindre à `ElementType` ne compile pas.
 */
function peutPorterLeLabel(type: unknown): boolean {
  return typeof type === "string" ? LABELABLE.has(type) : true;
}

/**
 * Champ libellé + contrôle, espacement cohérent sur tous les formulaires.
 *
 * L'ASSOCIATION EST AUTOMATIQUE : `Field` génère un identifiant (`useId`) et l'injecte dans
 * son enfant unique quand celui-ci n'en porte pas déjà. Auparavant le libellé et le contrôle
 * n'étaient que deux frères : sans `htmlFor` — que presque aucun appelant ne passait — cliquer
 * le libellé ne focalisait rien et le champ n'avait aucun nom accessible.
 *
 * Deux garde-fous, pour ne rien casser là où l'enfant n'est pas un contrôle :
 * - plusieurs enfants (contrôle + message d'erreur, groupe de boutons…) ⇒ aucune injection ;
 * - enfant intrinsèque non « labelable » (`<div>` qui enveloppe un groupe) ⇒ aucune injection.
 *
 * `htmlFor` reste accepté et l'emporte : c'est un override explicite, pas la règle.
 */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  /** Force la cible du libellé — sinon `Field` s'en charge. */
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const auto = React.useId();
  const enfants = React.Children.toArray(children);
  const unique = enfants.length === 1 ? enfants[0] : null;
  const element =
    unique !== null && React.isValidElement(unique) && peutPorterLeLabel(unique.type)
      ? (unique as React.ReactElement<{ id?: string }>)
      : null;
  const idExistant = element?.props.id;
  const cible = htmlFor ?? idExistant ?? (element ? auto : undefined);
  const contenu =
    element && !idExistant && cible ? React.cloneElement(element, { id: cible }) : children;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={cible}>{label}</Label>
      {contenu}
      {hint && <p className="text-body leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}
