// Étend `expect` de Vitest avec les matchers DOM (toBeInTheDocument, etc.).
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";

// La suite assert des chaînes en français → on FIGE la locale des tests sur « fr »
// (le défaut produit est l'anglais depuis 0.8.13 ; ce défaut est couvert par i18n.test.tsx,
// qui purge la clé pour tester le vrai premier démarrage).
beforeEach(() => {
  localStorage.setItem("itsm-lang", "fr");
});

afterEach(() => {
  localStorage.clear();
  // sessionStorage porte des ceintures anti-boucle inter-pages (`itsm.setup-settled`,
  // `itsm.login-redirect-at`) : les laisser fuiter d'un test à l'autre rendrait l'ordre
  // d'exécution significatif.
  sessionStorage.clear();
});
