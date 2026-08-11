/**
 * Jauge de robustesse du mot de passe — écrite à la main, ZÉRO dépendance.
 *
 * POURQUOI PAS zxcvbn : la discipline de bundle est un invariant du projet, et la
 * bibliothèque de référence pèse plus lourd que toute la page qui l'afficherait. On ne
 * cherche d'ailleurs pas à estimer une entropie : on cherche à répondre « est-ce que ce
 * mot de passe tiendra deux minutes face à un dictionnaire ? », ce que quelques règles
 * lisibles font honnêtement.
 *
 * CE QUE LA JAUGE NE FAIT JAMAIS : bloquer. Le moteur accepte tout mot de passe d'au
 * moins `MIN_PASSWORD_CHARS` caractères ; durcir la règle côté client refuserait ce que
 * le serveur, lui, accepte — l'admin se retrouverait à négocier avec un formulaire au
 * lieu d'installer son outil. Le score INFORME (et suggère), il n'autorise rien.
 */

import { MIN_PASSWORD_CHARS } from "./api";

/** 0 = très faible … 4 = excellent. Échelle bornée, jamais hors de [0, 4]. */
export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordVerdict {
  score: PasswordScore;
  /** Assez long pour que le moteur l'accepte — le SEUL critère bloquant. */
  longEnough: boolean;
  /**
   * Levier le plus rentable pour progresser, ou `null` quand il n'y a plus rien à dire.
   * Formulé comme une suggestion (« ajouter »), jamais comme un reproche.
   */
  advice: null | "length" | "variety" | "common" | "repetition";
}

/**
 * Mots de passe (et racines) que n'importe quel dictionnaire essaie dans sa première
 * seconde. Liste volontairement COURTE et bilingue : elle n'a pas vocation à être
 * exhaustive — c'est un garde-fou contre les choix réflexes du jour d'installation
 * (« admin1234 », « glpi2024 »), pas un filtre anti-intrusion.
 */
const WEAK_ROOTS = [
  "password",
  "passwd",
  "motdepasse",
  "azerty",
  "qwerty",
  "123456",
  "admin",
  "administrateur",
  "administrator",
  "itsm",
  "glpi",
  "changeme",
  "letmein",
  "welcome",
  "bienvenue",
  "soleil",
  "iloveyou",
];

/** Le mot de passe se réduit-il à un motif répété (« abcabcabc », « aaaaaaaa ») ? */
function isRepetition(pw: string): boolean {
  const lower = pw.toLowerCase();
  // Un motif de longueur `n` ne peut se répéter que si `n` divise la longueur totale.
  for (let n = 1; n <= lower.length / 2; n++) {
    if (lower.length % n !== 0) continue;
    const unit = lower.slice(0, n);
    if (unit.repeat(lower.length / n) === lower) return true;
  }
  return false;
}

/**
 * Note un mot de passe. Trois apports (longueur, variété, absence de motif connu), et
 * des PLAFONDS plutôt que des malus : un mot de passe de 40 caractères tous identiques
 * ne doit pas récolter la note de la longueur.
 */
export function scorePassword(pw: string): PasswordVerdict {
  const longEnough = pw.length >= MIN_PASSWORD_CHARS;
  if (!pw) return { score: 0, longEnough: false, advice: null };
  if (!longEnough) return { score: 0, longEnough: false, advice: "length" };

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length;

  let score = 1; // le minimum légal vaut « faible », jamais « nul »
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (classes >= 3) score++;
  if (classes >= 4 && pw.length >= 12) score++;

  // Plafonds : une faiblesse structurelle prime sur les points accumulés.
  const lower = pw.toLowerCase();
  const weak = WEAK_ROOTS.some((root) => lower.includes(root));
  const repeated = isRepetition(pw);
  if (weak) score = Math.min(score, 1);
  if (repeated) score = Math.min(score, 1);

  const clamped = Math.max(0, Math.min(4, score)) as PasswordScore;
  const advice: PasswordVerdict["advice"] = weak
    ? "common"
    : repeated
      ? "repetition"
      : clamped >= 4
        ? null
        : pw.length < 16
          ? "length"
          : "variety";
  return { score: clamped, longEnough: true, advice };
}
