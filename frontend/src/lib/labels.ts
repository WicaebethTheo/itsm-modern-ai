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

/**
 * Étape du pipeline où la Décision a été refusée. Sert à NOMMER correctement le refus :
 * une confiance sous le seuil n'est pas un refus de la liste blanche, et l'afficher comme
 * tel désigne le mauvais écran à corriger.
 */
export type ReasonStage = "ok" | "llm" | "whitelist" | "threshold" | "cap";

/** Chaque valeur de `TriageReason` (domain/models.py) : libellé bilingue + étape. */
const REASONS: Record<string, { fr: string; en: string; stage: ReasonStage }> = {
  accepted: { fr: "Traitée", en: "Handled", stage: "ok" },
  invalid_output: { fr: "Réponse du LLM illisible", en: "Unreadable LLM answer", stage: "llm" },
  category_not_in_whitelist: {
    fr: "Catégorie hors périmètre",
    en: "Category out of scope",
    stage: "whitelist",
  },
  priority_not_in_whitelist: {
    fr: "Priorité hors périmètre",
    en: "Priority out of scope",
    stage: "whitelist",
  },
  technician_not_in_whitelist: {
    fr: "Technicien hors périmètre",
    en: "Technician out of scope",
    stage: "whitelist",
  },
  no_eligible_assignee: {
    fr: "Aucun destinataire éligible",
    en: "No eligible assignee",
    stage: "whitelist",
  },
  low_confidence: {
    fr: "Confiance sous le seuil",
    en: "Confidence below threshold",
    stage: "threshold",
  },
  llm_error: { fr: "Erreur du fournisseur IA", en: "AI provider error", stage: "llm" },
  cost_cap_reached: { fr: "Plafond de coût atteint", en: "Cost cap reached", stage: "cap" },
};

/**
 * Libellé i18n d'un motif de triage. Repli sur la clé brute si le moteur en ajoute une :
 * mieux vaut afficher `nouveau_motif` que rien, mais l'UI ne doit plus, par défaut, rendre
 * du snake_case anglais dans une console française.
 */
export function reasonLabel(reason: string | null | undefined, t: T): string {
  if (!reason) return "—";
  const entry = REASONS[reason];
  return entry ? t(entry.fr, entry.en) : reason;
}

/** Étape de refus, ou `null` si le motif est inconnu du catalogue. */
export function reasonStage(reason: string | null | undefined): ReasonStage | null {
  if (!reason) return null;
  return REASONS[reason]?.stage ?? null;
}

/**
 * Couleur d'un motif. La distinction porte l'action attendue, pas la gravité ressentie :
 * ROUGE = le moteur est EMPÊCHÉ et l'admin doit intervenir (LLM en erreur, plafond
 * atteint) ; AMBRE = un garde-fou a joué comme prévu, il n'y a rien de cassé.
 */
export function reasonTone(reason: string | null | undefined): TagTone {
  if (reason === "accepted") return "green";
  const stage = reasonStage(reason);
  if (stage === "llm" || stage === "cap") return "red";
  return "amber";
}

/** Couleur de confiance — seuils alignés sur l'intuition opérateur (≥80 fort, <40 douteux). */
export function confidenceTone(c: number | null | undefined): TagTone {
  if (c == null) return "muted";
  if (c >= 0.8) return "green";
  if (c >= 0.6) return "indigo";
  if (c >= 0.4) return "amber";
  return "red";
}
