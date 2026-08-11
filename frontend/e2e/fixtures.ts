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

/** Force le thème (les deux sont livrés ; les captures visent l'un puis l'autre). */
export async function useTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem("itsm-theme", t);
  }, theme);
}
