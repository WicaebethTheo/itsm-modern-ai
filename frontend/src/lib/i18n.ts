import { useCallback, useSyncExternalStore } from "react";

// Store de langue FR/EN — externe (localStorage + event), lu via useSyncExternalStore.
// Porté de la maquette « operator preview ». Défaut au premier démarrage : EN
// (seul un choix explicite « fr » bascule en français).
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

export function snapshot(): Lang {
  return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "fr" ? "fr" : "en";
}

export function useLang() {
  const lang = useSyncExternalStore(subscribe, snapshot, () => "en" as Lang);
  const setLang = useCallback((l: Lang) => {
    localStorage.setItem(KEY, l);
    document.documentElement.setAttribute("lang", l);
    window.dispatchEvent(new Event(LANG_EVENT));
  }, []);
  return { lang, setLang };
}

/**
 * Locale de formatage (dates, nombres, montants) dérivée de la langue de l'interface.
 *
 * SOURCE UNIQUE, et ce n'était pas cosmétique : trois dérivations coexistaient, dont une qui
 * produisait `en-GB` — les dates d'absence et de dernier scan s'affichaient donc au format
 * britannique (« 22 Aug ») dans une interface par ailleurs américaine (« Aug 22 »).
 */
export function localeFor(lang: Lang): string {
  return lang === "fr" ? "fr-FR" : "en-US";
}

/** Hook : la locale de formatage de la langue courante. */
export function useLocale(): string {
  return localeFor(useLang().lang);
}

/** Hook : t(fr, en) renvoie la chaîne pour la langue courante. */
export function useT() {
  const { lang } = useLang();
  return useCallback((fr: string, en: string) => (lang === "fr" ? fr : en), [lang]);
}

/**
 * Variante non-React de t(fr, en) — pour le code hors composants (ex. messages
 * d'ApiError, fallback de hooks). Lit la langue au moment de l'appel : pas de
 * réactivité, mais suffisant pour des messages construits à la volée.
 */
export function tr(fr: string, en: string): string {
  return snapshot() === "fr" ? fr : en;
}
