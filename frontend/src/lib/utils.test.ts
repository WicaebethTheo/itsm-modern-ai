import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("concatène les classes", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("ignore les valeurs falsy (conditionnelles)", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("dédoublonne les classes Tailwind en conflit (la dernière gagne)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  // Régression. `text-*` désigne à la fois la taille et la couleur ; `tailwind-merge`
  // tranche sur une liste de tailles CONNUES et range tout le reste dans les couleurs.
  // Nos jetons `@theme` lui étant inconnus, il les prenait pour des couleurs et les
  // supprimait dès qu'une vraie couleur figurait dans la même chaîne — c'est-à-dire dans
  // presque toute la couche UI (tags, bannières, toasts, libellés rendus à la taille
  // héritée). Rien ne le voyait : la classe est ABSENTE du DOM, pas fausse.
  const JETONS = ["caption", "body", "ui", "title", "metric", "hero"] as const;

  it.each(JETONS)("garde le jeton de taille text-%s à côté d'une couleur", (jeton) => {
    expect(cn(`text-${jeton}`, "text-foreground")).toBe(`text-${jeton} text-foreground`);
  });

  it("fait toujours s'écraser deux tailles entre elles", () => {
    expect(cn("text-ui", "text-body")).toBe("text-body");
    expect(cn("text-caption", "text-[15px]")).toBe("text-[15px]");
    expect(cn("text-sm", "text-hero")).toBe("text-hero");
  });

  it("fait toujours s'écraser deux couleurs entre elles", () => {
    expect(cn("text-foreground", "text-muted-foreground")).toBe("text-muted-foreground");
  });
});
