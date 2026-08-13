import * as React from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
 * Composants du dépôt dont on SAIT qu'ils relaient `id` au contrôle natif qu'ils rendent
 * (`{...props}` sur un `<input>` / `<textarea>` / `<select>`). Liste blanche EXPLICITE, et
 * non « tout ce qui n'est pas une balise » : un fragment, un composant de mise en page ou
 * un composant maison qui avale ses props recevrait sinon l'identifiant sans jamais le
 * poser sur un contrôle — le `<label for>` pointerait dans le vide, ce qui est PIRE que
 * pas de libellé (un lecteur d'écran annonce alors un champ sans nom, et le clic sur le
 * libellé ne focalise rien). Un nouveau composant de champ s'ajoute ici sciemment.
 */
const COMPOSANTS_RELAIS: readonly unknown[] = [Input, Textarea, Select];

/**
 * Le paramètre est volontairement large : `ReactElement.type` vaut `string` OU un
 * constructeur de composant, et le restreindre à `ElementType` ne compile pas.
 */
function peutPorterLeLabel(type: unknown): boolean {
  return typeof type === "string" ? LABELABLE.has(type) : COMPOSANTS_RELAIS.includes(type);
}

/**
 * Champ libellé + contrôle, espacement cohérent sur tous les formulaires.
 *
 * L'ASSOCIATION EST AUTOMATIQUE : `Field` génère un identifiant (`useId`) et l'injecte dans
 * son enfant unique quand celui-ci n'en porte pas déjà. Auparavant le libellé et le contrôle
 * n'étaient que deux frères : sans `htmlFor` — que presque aucun appelant ne passait — cliquer
 * le libellé ne focalisait rien et le champ n'avait aucun nom accessible.
 *
 * Trois garde-fous, pour ne rien casser là où l'enfant n'est pas un contrôle :
 * - plusieurs enfants (contrôle + message d'erreur, groupe de boutons…) ⇒ aucune injection ;
 * - enfant intrinsèque non « labelable » (`<div>` qui enveloppe un groupe) ⇒ aucune injection ;
 * - enfant composant hors liste blanche (`COMPOSANTS_RELAIS`) ⇒ aucune injection.
 *
 * `htmlFor` reste accepté, mais c'est l'identifiant DÉJÀ PORTÉ par l'enfant qui gagne quand
 * les deux divergent : un `htmlFor` copié-collé d'un autre appelant pointerait sinon sur le
 * champ du formulaire voisin, en silence. Le conflit est signalé en développement.
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
  if (
    import.meta.env.DEV &&
    htmlFor !== undefined &&
    idExistant !== undefined &&
    htmlFor !== idExistant
  ) {
    console.warn(
      `Field « ${label} » : htmlFor="${htmlFor}" contredit l'id="${idExistant}" de son enfant ; ` +
        "c'est l'id de l'enfant qui est utilisé (le libellé doit désigner CE contrôle).",
    );
  }
  const cible = idExistant ?? htmlFor ?? (element ? auto : undefined);
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
