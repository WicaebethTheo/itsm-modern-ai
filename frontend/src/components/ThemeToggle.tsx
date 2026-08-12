import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { getStoredTheme, setTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Bascule clair/sombre, persistée. `compact` = carré-icône pour la topbar (mock-ctrl). */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme());
  const t = useT();

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  const Icon = theme === "dark" ? Sun : Moon;
  const label =
    theme === "dark"
      ? t("Passer en clair", "Switch to light")
      : t("Passer en sombre", "Switch to dark");

  if (compact) {
    return (
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={toggle}
        aria-label={label}
        title={label}
        className="border-border bg-transparent text-muted-foreground hover:text-foreground"
      >
        <Icon />
      </Button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-ui text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
      {theme === "dark" ? t("Mode clair", "Light mode") : t("Mode sombre", "Dark mode")}
    </button>
  );
}
