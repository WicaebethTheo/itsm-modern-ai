/**
 * Captures d'écran du README, prises sur le mode DÉMO (`/demo`).
 *
 * Le mode démo sert des données entièrement simulées (`src/lib/demo.ts`) : aucune
 * capture ne peut donc exposer un ticket, un technicien ou une clé d'un déploiement
 * réel. C'est aussi ce qui rend ces images reproductibles — même jeu de données à
 * chaque exécution, quel que soit l'état de l'instance qui les sert.
 *
 * Usage (une instance servant la SPA doit écouter sur BASE, 8000 par défaut) :
 *   node scripts/screenshots.mjs
 *   BASE=http://localhost:5173 node scripts/screenshots.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://localhost:8000";
const OUT = new URL("../../.github/assets/", import.meta.url).pathname;

// Largeur volontairement large : le README affiche ces images à ~800 px, un rendu
// desktop y reste lisible là où une capture étroite replierait la sidebar.
const VIEWPORT = { width: 1600, height: 1000 };

const SHOTS = [
  { path: "/demo/", name: "dashboard" },
  { path: "/demo/journal", name: "journal" },
  { path: "/demo/privacy", name: "confidentialite" },
  { path: "/demo/status", name: "statut" },
];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: VIEWPORT,
  deviceScaleFactor: 2, // rendu net sur écran HiDPI
  locale: "fr-FR",
});

// La console démarre en anglais tant qu'aucun choix explicite n'est stocké (`src/lib/i18n.ts`),
// et le thème sombre est son défaut assumé. On pose la langue AVANT le premier rendu :
// réglée après coup, la capture attraperait la bascule au lieu de la page.
await page.addInitScript(() => {
  localStorage.setItem("itsm-lang", "fr");
  localStorage.setItem("itsm-theme", "dark");
});

await mkdir(OUT, { recursive: true });

for (const shot of SHOTS) {
  await page.goto(BASE + shot.path, { waitUntil: "networkidle" });
  // Le widget flottant (GitHub + don) recouvre le coin bas-droit de chaque page. Il a sa
  // place dans la console, aucune sur une capture de documentation.
  await page.addStyleTag({ content: ".fixed.bottom-6.right-6.z-50 { display: none !important; }" });
  // Les graphiques (Recharts) s'animent au montage : sans cette pause, la capture
  // fige des barres à mi-hauteur.
  await page.waitForTimeout(1200);
  // Playwright ne sait écrire que du PNG ou du JPEG. À cette définition, le PNG pèse
  // ~875 Kio par capture — quatre captures suffiraient à alourdir le dépôt de 3,4 Mio,
  // pour toujours (git n'oublie pas un binaire). On repasse donc l'image par le canvas
  // du navigateur qui, lui, encode en WebP : ~177 Kio, sans perte visible sur du texte
  // d'interface. Aucune dépendance système (ni cwebp, ni sharp) n'est requise.
  const png = await page.screenshot();
  const webp = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/webp", 0.9).split(",")[1];
  }, png.toString("base64"));
  const file = `${OUT}${shot.name}.webp`;
  await writeFile(file, Buffer.from(webp, "base64"));
  console.log(`✓ ${shot.name} → ${file}`);
}

await browser.close();
