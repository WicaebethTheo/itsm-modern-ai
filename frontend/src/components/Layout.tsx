import { FloatingActions } from "@/components/FloatingActions";
import { LangToggle } from "@/components/LangToggle";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useResource } from "@/hooks/useResource";
import { Api, updateCommand } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { type IconName, NAV, navByPath } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { Heart, LogOut } from "lucide-react";
import { useCallback, useEffect } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

/** Les 4 icônes de la section « Opération » (fidèles à la maquette). */
function SidebarIcon({ name }: { name: IconName }) {
  const common = {
    className: "h-3.5 w-3.5 shrink-0",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
  } as const;
  if (name === "grid")
    return (
      <svg {...common} aria-hidden="true">
        <rect x="3" y="3" width="7" height="9" />
        <rect x="14" y="3" width="7" height="5" />
        <rect x="14" y="12" width="7" height="9" />
        <rect x="3" y="16" width="7" height="5" />
      </svg>
    );
  if (name === "clock")
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  if (name === "log")
    return (
      <svg {...common} aria-hidden="true">
        <path d="M3 4h18v4H3zM3 10h18v4H3zM3 16h18v4H3z" />
      </svg>
    );
  return (
    <svg {...common} aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  );
}

function Topbar({ onLogout }: { onLogout: () => void }) {
  const t = useT();
  const { pathname } = useLocation();
  const item = navByPath(pathname);
  const title = item ? t(item.fr, item.en) : "ITSM Modern AI";
  const health = useResource(useCallback(() => Api.health(), []));
  const g = health.data?.glpi;
  const version = useResource(useCallback(() => Api.version(), []));
  const v = version.data;
  const license = useResource(useCallback(() => Api.getLicense(), []));
  // Édition = Supporter uniquement si une feature est réellement active (cohérent Store).
  const isSupporter = (license.data?.features ?? []).some((f) => f.active);
  // Re-vérifie périodiquement (page ouverte) → l'indicateur de MAJ se met à jour seul,
  // sans recharger ni redémarrer. Le backend met le résultat en cache (TTL configurable).
  const reloadVersion = version.reload;
  useEffect(() => {
    const id = setInterval(() => reloadVersion(), 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [reloadVersion]);

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-5 sm:px-6">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="truncate text-[15px] font-medium tracking-tight">{title}</h1>
        {pathname === "/" && (
          <span className="hidden text-[12px] text-muted-foreground sm:inline">
            {t("· derniers 14 jours", "· last 14 days")}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {/* Accès rapide à la page Supporter (licence). Violet, en haut à droite. */}
        <NavLink
          to="/store"
          title={t("Supporter — licence & fonctionnalités", "Supporter — license & features")}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
            isSupporter
              ? "border-accent-purple/40 bg-accent-purple/20 text-accent-purple"
              : "border-accent-purple/30 bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20",
          )}
        >
          <Heart className="h-3.5 w-3.5" fill={isSupporter ? "currentColor" : "none"} />
          Supporter
        </NavLink>
        {/* Édition courante. Quand une licence est active, le bouton violet ci-dessus
            indique déjà "Supporter" → on n'affiche le badge que pour l'état Community
            (sinon double "Supporter" : bouton + badge). */}
        {license.data && !isSupporter ? (
          <span
            className="hidden rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground md:inline"
            title={t("Édition", "Edition")}
          >
            Community
          </span>
        ) : null}
        {/* Runtime : Docker (conteneur) ou Hôte (installé direct). Sert aussi à
            proposer la bonne commande de MAJ dans l'infobulle ci-dessous. */}
        {v?.runtime ? (
          <span
            className="hidden rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground md:inline"
            title={
              v.runtime === "docker"
                ? t("Exécution en conteneur Docker", "Running in a Docker container")
                : t(
                    "Exécution directe sur l'hôte (hors conteneur)",
                    "Running directly on the host (no container)",
                  )
            }
          >
            {v.runtime === "docker" ? "Docker" : t("Hôte", "Host")}
          </span>
        ) : null}
        {v ? (
          v.update_available ? (
            <a
              href="https://docs.itsm-modern-ai.com/update/"
              target="_blank"
              rel="noopener noreferrer"
              title={t(
                `Mise à jour disponible (v${v.latest}) — ${updateCommand(v.runtime)} — voir la doc →`,
                `Update available (v${v.latest}) — ${updateCommand(v.runtime)} — see docs →`,
              )}
              className="hidden items-center gap-1 rounded-full border border-accent-indigo/40 bg-accent-indigo/10 px-2 py-0.5 text-[11px] font-medium text-accent-indigo md:flex"
            >
              ↑ v{v.latest}
            </a>
          ) : (
            <span
              className="hidden text-[11.5px] text-muted-foreground md:inline"
              title={t("Version installée", "Installed version")}
            >
              v{v.current}
            </span>
          )
        ) : null}
        <span className="hidden items-center gap-1.5 text-[12px] text-muted-foreground md:flex">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              !g?.configured
                ? "bg-muted-foreground/50"
                : g.reachable
                  ? "bg-success"
                  : "bg-destructive",
            )}
          />
          {!g?.configured
            ? t("GLPI non configuré", "GLPI not configured")
            : g.reachable
              ? g.version
                ? `GLPI ${g.version}`
                : t("GLPI connecté", "GLPI connected")
              : t("GLPI injoignable", "GLPI unreachable")}
        </span>
        <span
          className="hidden h-7 w-7 rounded-full sm:block"
          style={{ background: "linear-gradient(135deg,#6366f1,#8b8df7)" }}
          title={t("Administrateur", "Administrator")}
        />
        <LangToggle />
        <ThemeToggle compact />
        <button
          type="button"
          onClick={onLogout}
          aria-label={t("Déconnexion", "Sign out")}
          title={t("Déconnexion", "Sign out")}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

export function Layout() {
  const navigate = useNavigate();
  const t = useT();
  // API GLPI réellement configurée (affichée en pied de sidebar).
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const isV2 = cfg.data?.glpi_api_version === "v2";

  async function logout() {
    await Api.logout().catch(() => undefined);
    navigate("/login");
  }

  return (
    // Fond « backdrop » + padding : la console flotte dans un châssis centré.
    <div className="app-backdrop flex h-screen overflow-hidden p-3 sm:p-5">
      <div className="app-shell flex h-full w-full overflow-hidden rounded-xl border border-border bg-background text-foreground">
        {/* Sidebar fixe (224px), bordure droite fine. */}
        <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar p-3 text-[13px]">
          <div className="mb-2 flex items-center gap-2 px-2 py-2">
            <Logo className="h-5 w-5" />
            <span className="font-semibold tracking-tight">ITSM Modern AI</span>
          </div>

          {NAV.map((section) => (
            <div key={section.en} className="flex flex-col gap-0.5">
              <p
                className="px-2 pt-4 pb-1 text-[10.5px] font-medium uppercase text-muted-foreground/70"
                style={{ letterSpacing: "0.12em" }}
              >
                {t(section.fr, section.en)}
              </p>
              {section.items.map((it) => (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.end}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors",
                      isActive
                        ? "bg-primary/15 text-accent-indigo"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )
                  }
                >
                  {it.icon && <SidebarIcon name={it.icon} />}
                  {t(it.fr, it.en)}
                </NavLink>
              ))}
            </div>
          ))}

          <div className="mt-auto flex flex-col gap-1.5 px-2 pt-3 text-[11px] text-muted-foreground">
            {cfg.data ? (
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    isV2 ? "bg-accent-indigo" : "bg-muted-foreground/50",
                  )}
                />
                {isV2
                  ? t("API GLPI : V2 (OAuth2)", "GLPI API: V2 (OAuth2)")
                  : t("API GLPI : apirest", "GLPI API: apirest")}
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
              {t("Moteur en marche", "Engine running")}
            </div>
          </div>
        </aside>

        {/* Zone principale : topbar + contenu défilant. */}
        <div className="app-content flex min-w-0 flex-1 flex-col">
          <Topbar onLogout={logout} />
          <main className="flex-1 overflow-y-auto p-5 sm:p-6">
            <Outlet />
          </main>
        </div>
      </div>
      <FloatingActions />
    </div>
  );
}
