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
      // Seuils = CLIQUET posé sous la mesure réelle (69,0 % / 60,2 % / 69,7 % à la mise en
      // place), pas objectif. Ils empêchent l'érosion ; ils ne prétendent pas que la
      // couverture soit suffisante — `Dashboard.tsx` et `Debug.tsx` restent non testés,
      // c'est assumé (affichage en lecture seule, et outil désactivé par défaut en prod).
      thresholds: { statements: 65, branches: 56, lines: 65 },
    },
  },
});
