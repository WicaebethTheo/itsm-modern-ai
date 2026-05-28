import { describe, expect, it } from "vitest";
import { confidenceTone, priorityLabel, priorityTone } from "./labels";

const t = (fr: string, _en: string) => fr;
const tEn = (_fr: string, en: string) => en;

describe("priorityLabel", () => {
  it("rend les libellés français standard (1..6)", () => {
    expect(priorityLabel(1, t)).toBe("Très basse (1)");
    expect(priorityLabel(3, t)).toBe("Moyenne (3)");
    expect(priorityLabel(6, t)).toBe("Majeure (6)");
  });

  it("rend les libellés anglais quand t() retourne l'anglais", () => {
    expect(priorityLabel(3, tEn)).toBe("Medium (3)");
  });

  it("retourne — pour null/undefined", () => {
    expect(priorityLabel(null, t)).toBe("—");
    expect(priorityLabel(undefined, t)).toBe("—");
  });

  it("fallback sur #id pour une valeur hors plage (défensif)", () => {
    expect(priorityLabel(42, t)).toBe("#42 (42)");
  });
});

describe("priorityTone", () => {
  it("escalade de muted à red au fur et à mesure de la sévérité", () => {
    expect(priorityTone(1)).toBe("muted");
    expect(priorityTone(2)).toBe("green");
    expect(priorityTone(3)).toBe("indigo");
    expect(priorityTone(4)).toBe("amber");
    expect(priorityTone(5)).toBe("red");
    expect(priorityTone(6)).toBe("red"); // MAJEURE
  });
  it("muted si null/undefined", () => {
    expect(priorityTone(null)).toBe("muted");
    expect(priorityTone(undefined)).toBe("muted");
  });
});

describe("confidenceTone", () => {
  it("vert ≥ 0.8, indigo ≥ 0.6, amber ≥ 0.4, rouge sinon", () => {
    expect(confidenceTone(0.95)).toBe("green");
    expect(confidenceTone(0.8)).toBe("green");
    expect(confidenceTone(0.7)).toBe("indigo");
    expect(confidenceTone(0.5)).toBe("amber");
    expect(confidenceTone(0.2)).toBe("red");
  });
  it("muted si null/undefined", () => {
    expect(confidenceTone(null)).toBe("muted");
    expect(confidenceTone(undefined)).toBe("muted");
  });
});
