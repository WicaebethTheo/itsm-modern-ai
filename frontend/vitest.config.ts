/// <reference types="vitest" />
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Config dédiée aux tests (séparée de la config de build). jsdom + Testing Library ;
// `globals: true` active l'auto-cleanup de @testing-library/react entre les tests.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    // Le défaut (5 s) suffit à `vitest run` mais PAS à `test:coverage` : l'instrumentation
    // V8 multiplie le coût des tests qui peignent beaucoup de DOM, et la porte de la CI est
    // justement celle qui mesure. On voyait donc des échecs intermittents dont la cause
    // était la charge de la machine, jamais une assertion fausse — le pire genre de rouge,
    // celui qu'on prend l'habitude de relancer. Un délai franc plutôt qu'un test affaibli.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      // `include` EXPLICITE, et c'est le point le plus important de ce bloc. Par défaut,
      // Vitest ne mesure que les fichiers CHARGÉS par un test : un fichier sans aucun test
      // n'apparaît pas à 0 %, il sort du DÉNOMINATEUR. Mesuré ici : 81,6 % annoncé contre
      // 69,0 % réel, trois pages entières n'étant jamais exécutées. Un taux qui monte quand
      // on supprime un test est pire que pas de taux du tout.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**", // harnais de test
        "src/test-utils.tsx",
        "src/main.tsx", // point d'entrée : monte l'app, rien à assurer
        "src/vite-env.d.ts",
      ],
      reporter: ["text-summary", "text"],
      // Seuils = CLIQUET posé sous la mesure réelle, pas objectif : ils empêchent l'érosion,
      // ils ne prétendent pas que la couverture soit suffisante. Remontés de 65/56/65 à
      // 85/78/86 après la revue par écran (mesure : 88,3 % / 81,2 % / 89,1 %) — laisser le
      // cliquet vingt points sous la mesure aurait autorisé à défaire tout ce qui vient
      // d'être écrit sans qu'aucune porte ne bronche. `Dashboard.tsx` et `Debug.tsx`, seules
      // pages jamais testées jusqu'ici, ont désormais leur fichier de test.
      thresholds: { statements: 85, branches: 78, lines: 86 },
    },
  },
});
