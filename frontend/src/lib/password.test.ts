import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_CHARS } from "./api";
import { scorePassword } from "./password";

describe("scorePassword", () => {
  it("ne dit rien tant que rien n'est saisi", () => {
    expect(scorePassword("")).toEqual({ score: 0, longEnough: false, advice: null });
  });

  it("signale la longueur manquante en dessous du minimum du moteur", () => {
    const v = scorePassword("court");
    expect(v.longEnough).toBe(false);
    expect(v.advice).toBe("length");
  });

  it("considère le minimum légal comme faible, jamais comme nul", () => {
    const v = scorePassword("abcdefgh");
    expect(v.longEnough).toBe(true);
    expect(v.score).toBeGreaterThanOrEqual(1);
  });

  it("récompense la longueur", () => {
    const court = scorePassword("abcdefgh").score;
    const long = scorePassword("abcdefghijklmnop").score;
    expect(long).toBeGreaterThan(court);
  });

  it("récompense la variété des classes de caractères", () => {
    expect(scorePassword("Tr0ubadour!x").score).toBeGreaterThan(scorePassword("troubadourx").score);
  });

  it("plafonne un mot de passe contenant une racine de dictionnaire", () => {
    const v = scorePassword("MotDePasse2026!");
    expect(v.score).toBeLessThanOrEqual(1);
    expect(v.advice).toBe("common");
  });

  it("plafonne un motif simplement répété", () => {
    const v = scorePassword("abcabcabcabcabcabc");
    expect(v.score).toBeLessThanOrEqual(1);
    expect(v.advice).toBe("repetition");
  });

  it("attribue la note maximale à une phrase de passe longue et variée", () => {
    const v = scorePassword("Trois chevaux bleus 42 !");
    expect(v.score).toBe(4);
    expect(v.advice).toBeNull();
  });

  it("borne toujours le score dans [0, 4]", () => {
    for (const pw of ["", "a", "x".repeat(200), "Aa1!".repeat(40), "azerty"]) {
      const { score } = scorePassword(pw);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(4);
    }
  });

  it("ne juge jamais plus sévèrement que le moteur : dès le minimum, c'est acceptable", () => {
    expect(scorePassword("x".repeat(MIN_PASSWORD_CHARS)).longEnough).toBe(true);
  });
});
