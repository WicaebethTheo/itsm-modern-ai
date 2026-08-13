import type { ReactNode } from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** En-tête de carte avec une icône à gauche du titre. */
export function HeadTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      {children}
    </span>
  );
}

/**
 * Bandeau d'échec de LECTURE.
 *
 * Un formulaire de réglages qui n'a pas pu lire le serveur n'est pas vide : il est rempli de
 * ses propres défauts. Enregistrer écraserait alors la configuration réelle par eux. L'écran
 * doit donc le dire — et c'est aussi pourquoi le bouton reste inerte tant que la lecture n'a
 * rien ramené (`peutEnregistrer` ci-dessous).
 */
export function ErreurDeLecture({ error }: { error: string | null }) {
  const t = useT();
  if (!error) return null;
  return (
    <Banner kind="error" role="alert">
      {t("Impossible de charger la configuration :", "Could not load the configuration:")} {error}
    </Banner>
  );
}

/**
 * Barre d'enregistrement collante, commune aux écrans de réglages du moteur.
 *
 * Elle « saigne » jusqu'aux bords du `<main>` (qui porte `p-5` / `sm:p-6`) et reste visible
 * au bas du conteneur défilant : sur un écran de réglages, le bouton ne doit pas dépendre de
 * la position de défilement.
 *
 * `alerte` sert au seul écran qui peut ARMER une écriture GLPI : il ne suffit pas d'y dire
 * « modifications non enregistrées » quand ce qui est en jeu est le passage en écriture
 * réelle.
 */
export function SaveBar({
  dirty,
  saving,
  peutEnregistrer,
  onSave,
  alerte,
}: {
  dirty: boolean;
  saving: boolean;
  peutEnregistrer: boolean;
  onSave: () => void;
  alerte?: string;
}) {
  const t = useT();
  return (
    // `data-savebar` : repère lu par `FloatingActions` pour se pousser au-dessus de cette
    // barre. Sans lui, le widget « café » recouvrait la moitié basse du bouton (mesuré à
    // 1366×768). Un attribut plutôt qu'une connaissance des routes dans le Layout : la barre
    // est la seule à savoir qu'elle existe, et le jour où un autre écran l'adopte, ça suit.
    <div
      data-savebar=""
      className={cn(
        "sticky bottom-0 z-20 -mx-5 -mb-5 mt-2 border-t border-border bg-card/95 backdrop-blur",
        "supports-[backdrop-filter]:bg-card/80 sm:-mx-6 sm:-mb-6",
      )}
    >
      <div className="flex items-center justify-between gap-4 px-5 py-3 sm:px-6">
        {/* Region live, comme la barre de `Scope.tsx` dont celle-ci est issue : l'attribut
            s'etait perdu a la factorisation. Sans lui, le message `alerte` — « dont le
            passage en ecriture reelle dans GLPI » — est inaudible, et le bouton etant
            `disabled` tant que rien n'a change, il sort aussi de l'ordre de tabulation :
            un lecteur d'ecran ne trouvait ni la commande, ni son explication. */}
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "truncate text-body",
            alerte && dirty
              ? "font-medium text-destructive"
              : dirty
                ? "text-foreground"
                : "text-muted-foreground",
          )}
        >
          {alerte && dirty
            ? alerte
            : dirty
              ? t("Modifications non enregistrées.", "Unsaved changes.")
              : t("Tout est enregistré.", "Everything is saved.")}
        </p>
        <Button onClick={onSave} disabled={!peutEnregistrer || saving || !dirty}>
          {saving ? t("Enregistrement…", "Saving…") : t("Enregistrer", "Save")}
        </Button>
      </div>
    </div>
  );
}
