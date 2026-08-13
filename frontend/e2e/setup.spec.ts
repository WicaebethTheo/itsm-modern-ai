import { expect, test } from "@playwright/test";
import { mockConsoleApi, useFrench } from "./fixtures";

// Parcours de PREMIÈRE INSTALLATION, de bout en bout : moteur sans compte admin →
// création du compte dans l'interface → tableau de bord. Le châssis authentifié est mocké
// par `mockConsoleApi` (un endpoint oublié y est ajouté UNE fois pour tous les scénarios) ;
// ne restent en local que les routes propres au scénario : la sonde d'auth et son
// basculement au POST /api/auth/setup, qui fait passer la garde RequireAuth sur "/".
test("pas installé → création du compte → tableau de bord", async ({ page }) => {
  await useFrench(page);
  await mockConsoleApi(page);
  let configured = false;
  let submitted: unknown = null;

  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: {
        authenticated: configured,
        auth_configured: configured,
        setup_required: !configured,
      },
    }),
  );
  await page.route("**/api/auth/setup", async (route) => {
    submitted = route.request().postDataJSON();
    configured = true;
    return route.fulfill({
      json: { authenticated: true, auth_configured: true, setup_required: false },
    });
  });

  // La garde envoie sur l'installation, pas sur une connexion que personne ne peut passer.
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: /Bienvenue/ })).toBeVisible();

  // Chaque champ est atteint par son LABEL — y compris les deux mots de passe.
  await page.getByLabel("Adresse email").fill("admin@exemple.fr");
  await page.getByLabel("Nom affiché (optionnel)").fill("Théo");
  await page.getByLabel("Mot de passe", { exact: true }).fill("correct cheval pile 42");
  await page.getByLabel("Confirmation du mot de passe").fill("correct cheval pile 42");

  // La jauge informe pendant la frappe, sans jamais verrouiller le bouton.
  await expect(page.getByText(/Robustesse/)).toBeVisible();
  const submit = page.getByRole("button", { name: /Créer le compte/ });
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByRole("heading", { name: "Tableau de bord" })).toBeVisible();
  expect(submitted).toEqual({
    email: "admin@exemple.fr",
    password: "correct cheval pile 42",
    display_name: "Théo",
  });
  // Aucun secret ne doit avoir transité par l'URL (ni en query, ni en fragment).
  expect(page.url()).not.toContain("correct");
});

test("un compte déjà configuré ne peut pas repasser par l'installation", async ({ page }) => {
  await useFrench(page);
  await mockConsoleApi(page);
  let setupCalled = false;

  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { authenticated: false, auth_configured: true, setup_required: false } }),
  );
  await page.route("**/api/auth/setup", (route) => {
    setupCalled = true;
    return route.fulfill({
      status: 409,
      json: { detail: { code: "already_configured", message: "Déjà configuré." } },
    });
  });

  await page.goto("/setup");
  // Redirection vers la connexion : aucun formulaire de création n'est offert.
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  await expect(page.getByLabel("Confirmation du mot de passe")).toHaveCount(0);
  expect(setupCalled).toBe(false);
});

test("un compte créé entre-temps (409) renvoie vers la connexion sans insister", async ({
  page,
}) => {
  await useFrench(page);
  await mockConsoleApi(page);
  // Course réelle : la sonde dit « à installer », mais un autre onglet a créé le compte.
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { authenticated: false, auth_configured: false, setup_required: true } }),
  );
  await page.route("**/api/auth/setup", (route) =>
    route.fulfill({
      status: 409,
      json: { detail: { code: "already_configured", message: "Déjà configuré." } },
    }),
  );

  await page.goto("/setup");
  await page.getByLabel("Adresse email").fill("admin@exemple.fr");
  await page.getByLabel("Mot de passe", { exact: true }).fill("correct cheval pile 42");
  await page.getByLabel("Confirmation du mot de passe").fill("correct cheval pile 42");
  await page.getByRole("button", { name: /Créer le compte/ }).click();

  await expect(page.getByText("Un compte administrateur existe déjà sur ce moteur.")).toBeVisible();
  await page.getByRole("button", { name: "Aller à la connexion" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
