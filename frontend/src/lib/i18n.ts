import { useCallback, useSyncExternalStore } from "react";

// Store de langue FR/EN — externe (localStorage + event), lu via useSyncExternalStore.
// Porté de la maquette « operator preview ». Défaut : FR (outil souverain).
export type Lang = "fr" | "en";

const KEY = "itsm-lang";
const LANG_EVENT = "itsm-lang-change";

function subscribe(callback: () => void) {
  window.addEventListener(LANG_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(LANG_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function snapshot(): Lang {
  return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "en" ? "en" : "fr";
}

export function useLang() {
  const lang = useSyncExternalStore(subscribe, snapshot, () => "fr" as Lang);
  const setLang = useCallback((l: Lang) => {
    localStorage.setItem(KEY, l);
    document.documentElement.setAttribute("lang", l);
    window.dispatchEvent(new Event(LANG_EVENT));
  }, []);
  return { lang, setLang };
}

/** Hook : t(fr, en) renvoie la chaîne pour la langue courante. */
export function useT() {
  const { lang } = useLang();
  return useCallback((fr: string, en: string) => (lang === "fr" ? fr : en), [lang]);
}
