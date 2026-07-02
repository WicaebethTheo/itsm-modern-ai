import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("concatène les classes", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("ignore les valeurs falsy (conditionnelles)", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("dédoublonne les classes Tailwind en conflit (la dernière gagne)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
