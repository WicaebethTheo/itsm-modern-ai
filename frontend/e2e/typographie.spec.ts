import { expect, test } from "@playwright/test";

/**
 * La police déclarée est-elle celle qui PEINT ?
 *
 * `--font-sans` déclarait `"Geist Variable"` depuis la première version, avec un commentaire
 * expliquant que « tant que le paquet n'est pas installé, le fallback s'applique sans casse ».
 * Le paquet n'a jamais été installé, aucun fichier ne l'importait, et le fallback s'est
 * appliqué — sans casse, donc sans que rien ni personne ne le signale. Un stack de polices
 * échoue toujours en silence : c'est sa raison d'être, et c'est pourquoi il faut le tester.
 *
 * Ces vérifications sont E2E et pas unitaires : jsdom ne charge aucune police et ne peut
 * donc ni infirmer ni confirmer quoi que ce soit ici.
 */
test("la police du produit est réellement chargée, et depuis l'instance", async ({ page }) => {
  await page.goto("/login");
  await page.waitForFunction(() => document.fonts.status === "loaded");

  const faces = await page.evaluate(() =>
    [...document.fonts].map((f) => ({ family: f.family, status: f.status })),
  );
  // Au moins une @font-face « Geist Variable » servie ET chargée.
  expect(faces.some((f) => f.family === "Geist Variable")).toBe(true);

  // Elle peint : une famille absente mesurerait comme une famille inventée. C'est le
  // test qui manquait — celui qui distingue « déclarée » de « appliquée ».
  const mesures = await page.evaluate(() => {
    const mesure = (famille: string) => {
      const c = document.createElement("canvas").getContext("2d");
      if (!c) return 0;
      c.font = `13px ${famille}`;
      return c.measureText("Confidentialité (DPO) — Techniciens").width;
    };
    return { geist: mesure('"Geist Variable"'), fantome: mesure('"Police Absente 12345"') };
  });
  expect(mesures.geist).toBeGreaterThan(0);
  expect(mesures.geist).not.toBeCloseTo(mesures.fantome, 1);
});

test("aucune police n'est tirée d'un hôte tiers", async ({ page }) => {
  // Invariant de souveraineté : une instance air-gap doit afficher la même chose qu'une
  // autre. Une police de CDN casserait ça en silence — et renseignerait un tiers sur
  // chaque poste qui ouvre la console.
  // On compare sur l'HÔTE, pas sur l'origine : le port de l'aperçu Vite change d'un run à
  // l'autre, et c'est « quitte-t-on la machine » qu'on veut vérifier, pas « quel port ».
  const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const externes: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.protocol.startsWith("http") && !LOCAL.has(url.hostname)) externes.push(r.url());
  });
  await page.goto("/login");
  await page.waitForFunction(() => document.fonts.status === "loaded");
  expect(externes).toEqual([]);
});
