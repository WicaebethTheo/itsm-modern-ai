import { expect, test } from "@playwright/test";
import { mockAuthSession, mockConsoleApi, useFrench } from "./fixtures";

// 3e parcours E2E : après login, naviguer vers le Bac à sable, soumettre un
// texte de ticket et vérifier que la décision simulée (mockée) s'affiche
// (nom du technicien et nom de la catégorie résolus côté API).
test("login → sandbox : un texte de ticket donne une décision simulée", async ({ page }) => {
  await useFrench(page);
  await mockAuthSession(page);
  await mockConsoleApi(page);
  await page.route("**/api/privacy/test-mask", (route) =>
    route.fulfill({
      json: { masked: "Je n'arrive plus a me connecter, mot de passe refuse.", counts: {} },
    }),
  );
  // Réponse codée en dur conforme à l'interface SandboxResult (cf. lib/api.ts).
  await page.route("**/api/sandbox", (route) =>
    route.fulfill({
      json: {
        accepted: true,
        reason: "accepted",
        category: 1,
        category_name: "Compte / Authentification",
        priority: 3,
        technician_id: 11,
        technician_name: "Sylvain Martin",
        group_id: null,
        group_name: null,
        confidence: 0.9,
        draft: "Bonjour, nous avons bien reçu votre demande.",
      },
    }),
  );

  await page.goto("/login");
  await page.getByLabel("Adresse email").fill("admin@exemple.fr");
  await page.getByLabel("Mot de passe").fill("s3cretaire");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("heading", { name: "Tableau de bord" })).toBeVisible();

  // Navigation via la sidebar vers « Bac à sable » (label FR par défaut).
  await page.getByRole("link", { name: "Bac à sable" }).click();

  // Saisie du texte de ticket puis lancement de la simulation.
  await page
    .getByLabel("Contenu du ticket")
    .fill("Je n'arrive plus à me connecter, mot de passe refusé.");
  await page.getByRole("button", { name: "Simuler la décision" }).click();

  // La décision mockée résout le nom du technicien et celui de la catégorie.
  await expect(page.getByText("Sylvain Martin")).toBeVisible();
  await expect(page.getByText("Compte / Authentification")).toBeVisible();
});
