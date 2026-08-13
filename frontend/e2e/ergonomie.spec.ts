import { expect, test } from "@playwright/test";
import { mockAuthSession, mockConsoleApi, useFrench } from "./fixtures";

/**
 * Rien ne doit recouvrir une commande.
 *
 * La barre d'enregistrement des écrans de réglages est COLLANTE : sur une page assez longue
 * elle se pose au bas de la fenêtre — là où vivent précisément les widgets flottants. Mesuré
 * avant correction, à 1366×768 comme à 1280×720 : la moitié basse du bouton « Enregistrer »
 * recevait le lien « Offrir un café ». Un exploitant qui vise le bas du bouton, geste naturel
 * puisqu'il est en bas de l'écran, n'enregistrait pas son réglage et partait sur une page de
 * don. Un test unitaire ne peut pas voir ça : il faut une vraie mise en page, à une vraie
 * taille de fenêtre.
 *
 * 1366×768 est la résolution portable la plus répandue — c'est aussi celle où le défaut
 * apparaissait, et pas sur le 1440×900 d'un poste de développement.
 */
const TAILLES = [
  { w: 1440, h: 900 },
  { w: 1366, h: 768 },
  { w: 1280, h: 720 },
];

test("aucun widget flottant ne recouvre le bouton « Enregistrer »", async ({ page }) => {
  await useFrench(page);
  await mockAuthSession(page);
  await mockConsoleApi(page);
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { confidence_threshold: "0.7", response_tone: "" } }),
  );

  await page.goto("/login");
  await page.getByLabel("Adresse email").fill("admin@exemple.fr");
  await page.getByLabel("Mot de passe").fill("s3cretaire");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.getByRole("heading", { name: "Tableau de bord" }).waitFor();

  for (const { w, h } of TAILLES) {
    await page.setViewportSize({ width: w, height: h });
    // L'écran le plus LONG du moteur : c'est celui où la barre colle réellement en bas.
    await page.goto("/engine/prompt");
    await page.locator("h1", { hasText: "Prompt & réponse" }).waitFor();
    await page.getByLabel("Ton de la réponse").fill("cordial et bref");

    const bouton = page.getByRole("button", { name: "Enregistrer" });
    const boite = await bouton.boundingBox();
    expect(boite, `${w}×${h} : bouton introuvable`).not.toBeNull();
    if (!boite) continue;

    // On sonde le bouton sur toute sa hauteur : le défaut ne touchait que sa moitié basse.
    for (const part of [0.15, 0.35, 0.5, 0.75, 0.9]) {
      const recu = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x as number, y as number);
          return el ? (el.closest("a")?.getAttribute("href") ?? el.tagName) : "rien";
        },
        [boite.x + boite.width / 2, boite.y + boite.height * part],
      );
      expect(recu, `${w}×${h}, à ${part * 100} % de la hauteur du bouton`).toBe("BUTTON");
    }
  }
});
