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
    <Banner kind="error">
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
    <div
      className={cn(
        "sticky bottom-0 z-20 -mx-5 -mb-5 mt-2 border-t border-border bg-card/95 backdrop-blur",
        "supports-[backdrop-filter]:bg-card/80 sm:-mx-6 sm:-mb-6",
      )}
    >
      <div className="flex items-center justify-between gap-4 px-5 py-3 sm:px-6">
        <p
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
