import { describe, expect, it } from "vitest";
import { asBool } from "./api";

describe("asBool", () => {
  it("reconnaît les valeurs vraies (config en chaîne)", () => {
    for (const v of ["1", "true", "yes", "on", "vrai", "TRUE", " on "]) {
      expect(asBool(v)).toBe(true);
    }
  });

  it("renvoie false pour les valeurs fausses ou absentes", () => {
    for (const v of ["0", "false", "no", "", "n'importe", null, undefined]) {
      expect(asBool(v)).toBe(false);
    }
  });
});
