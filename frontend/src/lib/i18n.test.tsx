import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLang, useT } from "./i18n";

describe("useT", () => {
  it("renvoie le français par défaut", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("Bonjour", "Hello")).toBe("Bonjour");
  });

  it("renvoie l'anglais si la langue stockée est « en »", () => {
    localStorage.setItem("itsm-lang", "en");
    const { result } = renderHook(() => useT());
    expect(result.current("Bonjour", "Hello")).toBe("Hello");
  });

  it("réagit au changement de langue via setLang", () => {
    const { result } = renderHook(() => {
      const { lang, setLang } = useLang();
      const t = useT();
      return { lang, setLang, t };
    });
    expect(result.current.lang).toBe("fr");
    act(() => result.current.setLang("en"));
    expect(result.current.lang).toBe("en");
    expect(result.current.t("Oui", "Yes")).toBe("Yes");
  });
});
