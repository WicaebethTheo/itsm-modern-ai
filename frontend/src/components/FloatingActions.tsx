import { useResource } from "@/hooks/useResource";
import { AUTHOR_NAME, Api, BUYMEACOFFEE_URL, GITHUB_URL } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Coffee } from "lucide-react";
import { useCallback } from "react";

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.16-.02-2.1-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

/** Widgets flottants bas-droite : lien GitHub (toujours) + « café » (Community seulement,
 *  masqué pour un Supporter = client payant). La version vit dans la barre du haut. */
export function FloatingActions() {
  const t = useT();
  const lic = useResource(useCallback(() => Api.getLicense(), []));
  const isSupporter = (lic.data?.features ?? []).some((f) => f.active);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2">
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="GitHub"
        title={t("Code source du projet (GitHub)", "Project source code (GitHub)")}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition hover:text-foreground"
      >
        <GithubIcon />
      </a>
      {!isSupporter ? (
        <a
          href={BUYMEACOFFEE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-full bg-[#FFDD00] px-4 py-2 text-[12px] font-semibold text-black shadow-lg transition hover:brightness-95"
        >
          <Coffee className="h-4 w-4" />
          {t(`Offrir un café à ${AUTHOR_NAME}`, `Buy ${AUTHOR_NAME} a coffee`)}
        </a>
      ) : null}
    </div>
  );
}
