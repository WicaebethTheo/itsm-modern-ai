// Étend `expect` de Vitest avec les matchers DOM (toBeInTheDocument, etc.)
// et réinitialise le localStorage entre les tests (la langue y est stockée).
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(() => {
  localStorage.clear();
});
