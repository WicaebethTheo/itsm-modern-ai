/** Gestion du thème clair/sombre (persisté). Défaut : sombre (esthétique opérateur). */
export type Theme = "dark" | "light";

const KEY = "itsm-theme";

export function getStoredTheme(): Theme {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  return v === "light" ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

/** À appeler le plus tôt possible (avant le rendu) pour éviter le flash. */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}
