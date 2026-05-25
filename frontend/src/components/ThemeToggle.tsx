import { type Theme, getStoredTheme, setTheme } from "@/lib/theme";
import { Moon, Sun } from "lucide-react";
import { useState } from "react";

/** Bascule clair/sombre, persistée. */
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme());

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Passer en clair" : "Passer en sombre"}
      className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      {theme === "dark" ? "Mode clair" : "Mode sombre"}
    </button>
  );
}
