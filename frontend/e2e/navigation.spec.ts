import { expect, test } from "@playwright/test";
import { demo } from "../src/lib/demo";
import { mockAuthSession, mockConsoleApi, useFrench } from "./fixtures";

// Étend l'E2E à un 2e écran : après login, naviguer vers le Journal via la sidebar
// et y voir une décision. API mockée (fixtures de démo).
test("login → navigation vers le Journal des décisions", async ({ page }) => {
  await useFrench(page);
  await mockAuthSession(page);
  await mockConsoleApi(page);

  await page.goto("/login");
  await page.getByLabel("Adresse email").fill("admin@exemple.fr");
  await page.getByLabel("Mot de passe").fill("s3cretaire");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("heading", { name: "Tableau de bord" })).toBeVisible();

  // Navigation via la sidebar vers « Journaux ».
  await page.getByRole("link", { name: "Journaux" }).click();
  await expect(page.getByText("Journal des décisions")).toBeVisible();

  // Une décision de démo est listée (lien ticket cliquable).
  const firstTicket = demo.decisions[0].ticket_id;
  await expect(page.getByRole("link", { name: `#${firstTicket}` })).toBeVisible();
});
