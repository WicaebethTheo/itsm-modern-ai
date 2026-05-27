import { defineConfig, devices } from "@playwright/test";

// E2E : la SPA buildée est servie par `vite preview` ; le test intercepte /api et
// /health (API mockée, déterministe, sans toucher au moteur réel). Séparé de Vitest
// (testDir ./e2e, hors de src/ que scanne Vitest).
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
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
