import { defineConfig, devices } from "@playwright/test";

// E2E : la SPA buildée est servie par `vite preview` ; le test intercepte /api et
// /health (API mockée, déterministe, sans toucher au moteur réel). Séparé de Vitest
// (testDir ./e2e, hors de src/ que scanne Vitest).
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // UN SEUL worker, et c'est le sujet : `fullyParallel` sans borne lançait autant de
  // navigateurs que de cœurs sur la même machine, et la suite échouait de façon
  // INTERMITTENTE (« Target crashed » sur un clic de la barre latérale — le renderer est
  // tué par la pression mémoire, pas par le code testé). Trois exécutions consécutives :
  // 3, 1 puis 3 échecs en parallèle, 0 avec `--workers=1`. Une suite de 7 parcours qui
  // n'est verte qu'avec un drapeau que personne ne tape n'est pas une suite verte : la
  // commande PAR DÉFAUT (`npx playwright test`) doit être celle qui passe.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "line",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
