import { expect, test } from "@playwright/test";
import { mockAuthSession, mockConsoleApi, useFrench } from "./fixtures";

// Parcours critique : écran de login → connexion → tableau de bord.
// Toute l'API est mockée par `mockConsoleApi` (réponses dérivées des fixtures de démo, donc
// de forme correcte) : ce scénario rejouait ses propres `page.route` en dur, sans la version,
// la licence ni la configuration — et avec des motifs sans `*`, qui ne matchaient donc PAS
// `/api/decisions?limit=8`. Ces appels retombaient sur le repli HTML du serveur de
// prévisualisation : le tableau de bord s'affichait dégradé sans qu'aucune assertion ne le
// voie. `mockAuthSession` porte la bascule false→true du POST /login, qui fait passer la
// garde RequireAuth au retour sur "/".
test("login → dashboard (API mockée)", async ({ page }) => {
  await useFrench(page);
  await mockAuthSession(page);
  await mockConsoleApi(page);

  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Se connecter" })).toBeVisible();

  await page.getByLabel("Adresse email").fill("admin@exemple.fr");
  await page.getByLabel("Mot de passe").fill("s3cretaire");
  await page.getByRole("button", { name: "Se connecter" }).click();

  // Après login on est redirigé vers "/" ; le titre de la topbar = « Tableau de bord ».
  await expect(page.getByRole("heading", { name: "Tableau de bord" })).toBeVisible();
  // La topbar affiche la version GLPI remontée par /health.
  await expect(page.getByText("GLPI 10.0.18")).toBeVisible();
});

test("redirige vers /login si l'auth est requise et non connecté", async ({ page }) => {
  await useFrench(page);
  await mockConsoleApi(page);
  // Scénario-spécifique : la session RESTE fermée (pas de bascule), c'est le sujet du test.
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { authenticated: false, auth_configured: true, setup_required: false } }),
  );

  await page.goto("/");
  // La garde RequireAuth renvoie vers /login → les deux champs apparaissent.
  await expect(page.getByLabel("Adresse email")).toBeVisible();
  await expect(page.getByLabel("Mot de passe")).toBeVisible();
});
