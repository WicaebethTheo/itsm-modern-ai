import { describe, expect, it } from "vitest";
import { NAV, navByPath } from "./nav";

describe("navByPath", () => {
  it("résout la racine vers le Tableau de bord", () => {
    expect(navByPath("/")?.fr).toBe("Tableau de bord");
    expect(navByPath("")?.fr).toBe("Tableau de bord");
  });

  it("résout un chemin simple", () => {
    expect(navByPath("/scope")?.en).toBe("Business rules");
    expect(navByPath("/engine")?.fr).toBe("Moteur");
  });

  it("matche par préfixe (sous-route) sans laisser « / » tout capturer", () => {
    expect(navByPath("/status/extra")?.fr).toBe("Statut");
  });

  it("renvoie undefined pour un chemin inconnu", () => {
    expect(navByPath("/inconnu")).toBeUndefined();
  });

  it("titre une page hors sidebar (ouverte depuis le menu de compte)", () => {
    expect(navByPath("/account")?.fr).toBe("Compte & sécurité");
    expect(navByPath("/account")?.en).toBe("Account & security");
  });

  it("ne publie PAS /account dans la sidebar", () => {
    expect(NAV.flatMap((s) => s.items).some((i) => i.to === "/account")).toBe(false);
  });
});
