import type { Page } from "@playwright/test";

/**
 * Fige la langue de l'UI sur le français AVANT le premier rendu.
 *
 * Les scénarios ci-dessous assertent des libellés français, alors que le défaut produit
 * est l'anglais (`lib/i18n.ts` : seul un choix explicite « fr » bascule). Sans ce réglage,
 * les tests dépendent d'un défaut qu'ils n'ont pas choisi — c'est exactement le pendant
 * E2E de `src/test/setup.ts`, qui pose la même clé pour les tests unitaires.
 */
export async function useFrench(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("itsm-lang", "fr");
  });
}

/**
 * Mocke TOUT ce que le châssis authentifié appelle au montage.
 *
 * Pourquoi une fonction partagée plutôt qu'un `page.route` par scénario : un endpoint
 * oublié ne rate pas silencieusement. Il traverse le proxy Vite jusqu'au moteur réel,
 * qui répond 401 — et le client d'API renvoie alors sur `/login` (`navigation.toLogin`)
 * AU MILIEU du scénario, ce qui se manifeste par un clic « target crashed » sur un lien
 * de la sidebar, à mille lieues de la cause. Un seul endroit à tenir donc, et toute
 * nouvelle requête montée dans `Layout` s'ajoute ici une fois pour toutes.
 *
 * Les motifs se terminent par `*` quand la route accepte une chaîne de requête :
 * `**` + `/api/decisions` ne matche PAS `/api/decisions?limit=500`.
 */
export async function mockConsoleApi(page: Page): Promise<void> {
  const { demo } = await import("../src/lib/demo");
  await page.route("**/health*", (route) => route.fulfill({ json: demo.health }));
  await page.route("**/api/status*", (route) => route.fulfill({ json: demo.status }));
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: demo.me }));
  await page.route("**/api/version*", (route) => route.fulfill({ json: demo.version }));
  await page.route("**/api/license", (route) => route.fulfill({ json: demo.license }));
  await page.route("**/api/config", (route) => route.fulfill({ json: demo.config }));
  await page.route("**/api/metrics*", (route) => route.fulfill({ json: demo.metrics }));
  await page.route("**/api/operational-metrics*", (route) =>
    route.fulfill({ json: demo.operational }),
  );
  await page.route("**/api/decisions*", (route) => route.fulfill({ json: demo.decisions }));
}

/**
 * Session admin simulée : `status` suit l'état, `login` le fait basculer. Renvoie de quoi
 * enchaîner sur les mocks propres au scénario.
 */
export async function mockAuthSession(page: Page): Promise<void> {
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
}

/** Force le thème (les deux sont livrés ; les captures visent l'un puis l'autre). */
export async function useTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem("itsm-theme", t);
  }, theme);
}
