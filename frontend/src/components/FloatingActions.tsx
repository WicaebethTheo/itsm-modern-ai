import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Coffee } from "lucide-react";
import { useCallback, useState } from "react";

// Mise à jour = relancer le one-liner d'installation (idempotent : git pull + rebuild,
// données conservées dans ./data). Cf. bootstrap.sh / install.sh --build.
const UPDATE_CMD = "curl -fsSL https://itsm-modern-ai.com/install | sh";

/** Widgets flottants bas-droite : indicateur de version / mise à jour + « café ».
 *  Le bouton « café » est masqué en édition Enterprise (client payant). */
export function FloatingActions() {
  const t = useT();
  const ver = useResource(useCallback(() => Api.version(), []));
  const lic = useResource(useCallback(() => Api.getLicense(), []));
  const [open, setOpen] = useState(false);
  const v = ver.data;
  // Édition Enterprise = code des modules payants installé dans l'image.
  const isEnterprise = (lic.data?.features ?? []).some((f) => f.installed);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {v?.update_available ? (
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="rounded-full border border-accent-indigo/40 bg-accent-indigo/10 px-3 py-1 text-[11px] font-medium text-accent-indigo shadow-sm transition hover:bg-accent-indigo/20"
          >
            {t(`↑ Mise à jour v${v.latest} disponible`, `↑ Update v${v.latest} available`)}
          </button>
          {open ? (
            <div className="max-w-80 rounded-md border border-border bg-card p-3 text-[11px] shadow-lg">
              <p className="mb-1 text-muted-foreground">
                {t("Mettre à jour (données conservées) :", "Update (data preserved):")}
              </p>
              <code className="block overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[11px]">
                {UPDATE_CMD}
              </code>
            </div>
          ) : null}
        </div>
      ) : v ? (
        <span className="rounded-full bg-card/80 px-2.5 py-0.5 text-[10.5px] text-muted-foreground shadow-sm backdrop-blur">
          v{v.current}
        </span>
      ) : null}

      {!isEnterprise ? (
        <a
          href="https://buymeacoffee.com/tmeneboode"
          target="_blank"
          rel="noopener noreferrer"
          title="Théo MENEBOODE"
          className="flex items-center gap-2 rounded-full bg-[#FFDD00] px-4 py-2 text-[12px] font-semibold text-black shadow-lg transition hover:brightness-95"
        >
          <Coffee className="h-4 w-4" />
          {t("Offrir un café", "Buy me a coffee")}
        </a>
      ) : null}
    </div>
  );
}
