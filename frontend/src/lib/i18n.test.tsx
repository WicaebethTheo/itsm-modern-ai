import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useLang, useT } from "./i18n";

describe("useT", () => {
  // Ces tests valident la logique de défaut/persistance → on part SANS langue stockée
  // (le setup global force « fr » pour les autres suites ; ici on veut le vrai premier démarrage).
  beforeEach(() => {
    localStorage.removeItem("itsm-lang");
  });

  it("renvoie l'anglais par défaut (premier démarrage)", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("Bonjour", "Hello")).toBe("Hello");
  });

  it("renvoie le français si la langue stockée est « fr »", () => {
    localStorage.setItem("itsm-lang", "fr");
    const { result } = renderHook(() => useT());
    expect(result.current("Bonjour", "Hello")).toBe("Bonjour");
  });

  it("réagit au changement de langue via setLang", () => {
    const { result } = renderHook(() => {
      const { lang, setLang } = useLang();
      const t = useT();
      return { lang, setLang, t };
    });
    expect(result.current.lang).toBe("en");
    act(() => result.current.setLang("fr"));
    expect(result.current.lang).toBe("fr");
    expect(result.current.t("Oui", "Yes")).toBe("Oui");
  });
});
