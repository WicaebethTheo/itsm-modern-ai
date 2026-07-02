import { expect, test } from "@playwright/test";
import { demo } from "../src/lib/demo";

// Étend l'E2E à un 2e écran : après login, naviguer vers le Journal via la sidebar
// et y voir une décision. API mockée (fixtures de démo).
test("login → navigation vers le Journal des décisions", async ({ page }) => {
  let authenticated = false;
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { authenticated, auth_configured: true } }),
  );
  await page.route("**/api/auth/login", (route) => {
    authenticated = true;
    return route.fulfill({ json: { authenticated: true, auth_configured: true } });
  });
  await page.route("**/health", (route) => route.fulfill({ json: demo.health }));
  await page.route("**/api/metrics", (route) => route.fulfill({ json: demo.metrics }));
  await page.route("**/api/operational-metrics", (route) =>
    route.fulfill({ json: demo.operational }),
  );
  await page.route("**/api/decisions", (route) => route.fulfill({ json: demo.decisions }));

  await page.goto("/login");
  await page.locator('input[type="password"]').fill("s3cret");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("heading", { name: "Tableau de bord" })).toBeVisible();

  // Navigation via la sidebar vers « Journaux ».
  await page.getByRole("link", { name: "Journaux" }).click();
  await expect(page.getByText("Journal des décisions")).toBeVisible();

  // Une décision de démo est listée (lien ticket cliquable).
  const firstTicket = demo.decisions[0].ticket_id;
  await expect(page.getByRole("link", { name: `#${firstTicket}` })).toBeVisible();
});
