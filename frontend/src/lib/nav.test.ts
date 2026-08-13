import { describe, expect, it } from "vitest";
import { NAV, navByPath, OFF_SIDEBAR } from "./nav";

/**
 * Le registre est la SOURCE UNIQUE de la sidebar : ce qu'on y oublie n'existe nulle part
 * ailleurs. Ces règles ne sont pas cosmétiques — une entrée sans icône rouvre l'asymétrie
 * qu'on vient de corriger, et un chemin en double ferait clignoter deux lignes actives.
 */
describe("registre de navigation", () => {
  const toutes = [...NAV.flatMap((s) => s.items), ...OFF_SIDEBAR];

  it("chaque entrée porte une icône", () => {
    for (const it of toutes) expect(it.icon, `${it.to} sans icône`).toBeTruthy();
  });

  it("chaque entrée est bilingue et non vide", () => {
    for (const it of toutes) {
      expect(it.fr.length, it.to).toBeGreaterThan(0);
      expect(it.en.length, it.to).toBeGreaterThan(0);
    }
  });

  it("aucun chemin en double", () => {
    const chemins = toutes.map((i) => i.to);
    expect(new Set(chemins).size).toBe(chemins.length);
  });

  it("« Opération » ne contient que des écrans de lecture", () => {
    // La règle du classement : on n'y règle RIEN. « Connexion GLPI » y figurait alors qu'on
    // y saisit une URL et un jeton ; « Coûts & quotas » n'y figurait pas alors que la page
    // dit elle-même être en lecture seule.
    const operation = NAV.find((s) => s.en === "Operation");
    expect(operation?.items.map((i) => i.to)).toEqual(["/", "/status", "/journal", "/cost"]);
  });
});

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
