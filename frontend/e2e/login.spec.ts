import { expect, test } from "@playwright/test";
import { demo } from "../src/lib/demo";
import { useFrench } from "./fixtures";

// Parcours critique : écran de login → connexion → tableau de bord.
// Toute l'API est mockée (réponses dérivées des fixtures de démo, donc de forme
// correcte). L'état d'auth bascule à false→true au POST /login pour que la garde
// RequireAuth laisse passer au retour sur "/".
test("login → dashboard (API mockée)", async ({ page }) => {
  await useFrench(page);
  let authenticated = false;

  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { authenticated, auth_configured: true, setup_required: false } }),
  );
  await page.route("**/api/auth/login", (route) => {
    authenticated = true;
    return route.fulfill({
      json: { authenticated: true, auth_configured: true, setup_required: false },
    });
  });
  // Identité du compte : la topbar l'affiche dans son chip. Non mockée, elle retomberait
  // sur « Administrateur » — le parcours passerait quand même, mais sans exercer le chemin
  // réel (`GET /api/auth/me`, route authentifiée).
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: demo.me }));
  await page.route("**/health", (route) => route.fulfill({ json: demo.health }));
  await page.route("**/api/metrics", (route) => route.fulfill({ json: demo.metrics }));
  await page.route("**/api/operational-metrics", (route) =>
    route.fulfill({ json: demo.operational }),
  );
  await page.route("**/api/decisions", (route) => route.fulfill({ json: demo.decisions }));

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
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { authenticated: false, auth_configured: true, setup_required: false } }),
  );

  await page.goto("/");
  // La garde RequireAuth renvoie vers /login → les deux champs apparaissent.
  await expect(page.getByLabel("Adresse email")).toBeVisible();
  await expect(page.getByLabel("Mot de passe")).toBeVisible();
});
