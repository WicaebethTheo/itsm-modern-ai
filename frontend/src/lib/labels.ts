/**
 * Libellés humanisés + tons de couleur pour des valeurs numériques GLPI
 * (priorité, confiance). Source de vérité unique pour Sandbox + Journal + Dashboard.
 */

import type { TagTone } from "@/components/ui/tag";

type T = (fr: string, en: string) => string;

const PRIORITY_FR: Record<number, string> = {
  1: "Très basse",
  2: "Basse",
  3: "Moyenne",
  4: "Haute",
  5: "Très haute",
  6: "Majeure",
};

const PRIORITY_EN: Record<number, string> = {
  1: "Very low",
  2: "Low",
  3: "Medium",
  4: "High",
  5: "Very high",
  6: "Major",
};

/** Libellé i18n pour une priorité GLPI (1..6). Retourne "—" si null/inconnue. */
export function priorityLabel(p: number | null | undefined, t: T): string {
  if (p == null) return "—";
  const fr = PRIORITY_FR[p] ?? `#${p}`;
  const en = PRIORITY_EN[p] ?? `#${p}`;
  return `${t(fr, en)} (${p})`;
}

/** Couleur de priorité — sobre tant que ≤ Basse, attire l'œil dès Haute, alerte rouge ≥ Très haute. */
export function priorityTone(p: number | null | undefined): TagTone {
  if (p == null) return "muted";
  if (p <= 1) return "muted";
  if (p === 2) return "green";
  if (p === 3) return "indigo";
  if (p === 4) return "amber";
  return "red"; // 5 (Très haute) et 6 (Majeure)
}

/** Couleur de confiance — seuils alignés sur l'intuition opérateur (≥80 fort, <40 douteux). */
export function confidenceTone(c: number | null | undefined): TagTone {
  if (c == null) return "muted";
  if (c >= 0.8) return "green";
  if (c >= 0.6) return "indigo";
  if (c >= 0.4) return "amber";
  return "red";
}
