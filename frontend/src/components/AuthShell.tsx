import type { ReactNode } from "react";
import { LangToggle } from "@/components/LangToggle";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { APP_VERSION } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Châssis des écrans HORS session (installation, connexion).
 *
 * POURQUOI RÉUTILISER LE CHÂSSIS DE LA CONSOLE plutôt qu'une carte posée au centre :
 * ces deux écrans sont les premiers que voit un exploitant, et le produit doit y
 * ressembler à ce qu'il deviendra une fois connecté. On reprend donc, à l'identique,
 * l'assemblage de `Layout` — backdrop maillé, cadre rétroéclairé (gaine + nappe + filet),
 * panneau opaque — sans en réinventer une variante : mêmes classes, mêmes garanties
 * (masques, `prefers-reduced-motion`, aucune animation hors opacity/transform).
 *
 * LE RAIL DE GAUCHE est la moitié « le produit se présente ». Il disparaît sous `lg`,
 * où il serait une colonne vide au-dessus du formulaire : les pages fournissent alors un
 * en-tête compact équivalent (cf. `Setup`/`Login`).
 *
 * LES BASCULES LANGUE ET THÈME vivent ici, en haut à droite du panneau : ces écrans n'ont
 * ni topbar ni sidebar, et quelqu'un qui installe en anglais ne doit pas être coincé en
 * français le temps de créer son compte.
 */
export function AuthShell({
  aside,
  children,
  wide = false,
}: {
  /** Contenu du rail de présentation (colonne gauche, ≥ lg). */
  aside: ReactNode;
  children: ReactNode;
  /** Formulaire dense (installation) → panneau plus large qu'un simple login. */
  wide?: boolean;
}) {
  const t = useT();
  return (
    // `h-screen overflow-hidden` : la nappe lumineuse déborde de 56 px autour du cadre.
    // Sans ce clip, ce débord ouvrirait des barres de défilement sur la page entière —
    // c'est le panneau qui défile (colonne de droite), jamais le décor.
    <div className="app-backdrop flex h-screen items-center justify-center overflow-hidden p-3 sm:p-5">
      <div className={`app-shell-frame w-full ${wide ? "max-w-5xl" : "max-w-3xl"} max-h-full`}>
        {/* Rétroéclairage : mêmes calques que la console (détail dans index.css). */}
        <div className="app-shell-aura" aria-hidden="true">
          <div className="app-shell-aura-sheet" />
        </div>
        <div className="app-shell-glow" aria-hidden="true" />
        <div className="app-shell grid max-h-[calc(100vh-1.5rem)] w-full grid-cols-1 overflow-hidden rounded-xl border border-border bg-background text-foreground sm:max-h-[calc(100vh-2.5rem)] lg:grid-cols-[17.5rem_1fr]">
          <aside className="hidden flex-col justify-between border-r border-border bg-sidebar p-7 lg:flex">
            {aside}
            <p className="pt-8 text-[11px] text-muted-foreground">
              {t("Version", "Version")} {APP_VERSION} · {t("On-premise", "On-premise")}
            </p>
          </aside>

          {/* Colonne de droite : barre de contrôles fixe + contenu défilant. */}
          <div className="app-content flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-end gap-2 px-5 pt-4 sm:px-8">
              <LangToggle />
              <ThemeToggle compact />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Bloc d'identité compact affiché DANS la colonne de droite sous `lg`, quand le rail de
 * présentation est masqué. Le produit se nomme sur tous les formats, jamais un formulaire
 * anonyme.
 */
export function AuthBrandCompact({ tagline }: { tagline: string }) {
  return (
    <div className="flex items-center gap-2.5 pb-1 lg:hidden">
      <Logo className="h-6 w-6" />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-tight tracking-tight">ITSM Modern AI</p>
        <p className="truncate text-[11.5px] leading-tight text-muted-foreground">{tagline}</p>
      </div>
    </div>
  );
}
