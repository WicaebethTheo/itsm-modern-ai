import { useLang } from "@/lib/i18n";

/** Bascule FR/EN, persistée. Affichée dans la topbar (style mock-ctrl). */
export function LangToggle() {
  const { lang, setLang } = useLang();
  const next = lang === "fr" ? "en" : "fr";
  return (
    <button
      type="button"
      onClick={() => setLang(next)}
      aria-label={lang === "fr" ? "Switch to English" : "Passer en français"}
      title={lang === "fr" ? "English" : "Français"}
      className="flex h-7 items-center rounded-md border border-border px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {lang}
    </button>
  );
}
