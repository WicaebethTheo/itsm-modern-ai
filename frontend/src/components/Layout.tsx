import { ThemeToggle } from "@/components/ThemeToggle";
import { Api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Activity,
  Bot,
  Bug,
  Cpu,
  FlaskConical,
  FolderTree,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  PlugZap,
  ScrollText,
  ShieldCheck,
  Users,
  UsersRound,
} from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

// Navigation data-driven : ajouter une page = une ligne ici + une route.
// Les chemins `to` sont stables (liés au routeur) — ne pas les modifier.
const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Pilotage",
    items: [
      { to: "/", label: "Tableau de bord", icon: LayoutDashboard, end: true },
      { to: "/status", label: "Statut", icon: Activity },
      { to: "/journal", label: "Journal des décisions", icon: ScrollText },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/glpi", label: "Connexion GLPI", icon: PlugZap },
      { to: "/ai-provider", label: "Fournisseur IA", icon: Bot },
      { to: "/engine", label: "Moteur de triage", icon: Cpu },
    ],
  },
  {
    label: "Périmètre GLPI",
    items: [
      { to: "/scope", label: "Catégories", icon: FolderTree },
      { to: "/technicians", label: "Techniciens", icon: Users },
      { to: "/groups", label: "Groupes", icon: UsersRound },
    ],
  },
  {
    label: "Outils",
    items: [
      { to: "/sandbox", label: "Bac à sable", icon: FlaskConical },
      { to: "/debug", label: "Debug & tests", icon: Bug },
    ],
  },
];

export function Layout() {
  const navigate = useNavigate();

  async function logout() {
    await Api.logout().catch(() => undefined);
    navigate("/login");
  }

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r border-border bg-sidebar sm:w-60">
        <div className="flex h-16 items-center gap-2.5 border-b border-border/60 px-4 sm:px-5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <span className="hidden flex-col leading-tight sm:flex">
            <span className="text-sm font-semibold tracking-tight">ITSM Modern AI</span>
            <span className="text-[11px] text-muted-foreground">Console d'administration</span>
          </span>
        </div>

        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-2 py-4 sm:px-3">
          {SECTIONS.map((section) => (
            <div key={section.label} className="flex flex-col gap-1">
              <p className="hidden px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 sm:block">
                {section.label}
              </p>
              <div className="flex flex-col gap-0.5">
                {section.items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    title={label}
                    className={({ isActive }) =>
                      cn(
                        "group relative flex items-center justify-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors sm:justify-start",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className={cn(
                            "absolute left-0 h-5 w-0.5 rounded-r-full bg-primary transition-opacity",
                            isActive ? "opacity-100" : "opacity-0",
                          )}
                          aria-hidden
                        />
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="hidden sm:inline">{label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-border/60 px-2 py-3 sm:px-3">
          <div className="hidden sm:block">
            <ThemeToggle />
          </div>
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:justify-start"
            title="Déconnexion"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">Déconnexion</span>
          </button>
          <div className="mt-2 hidden items-center gap-2 px-3 sm:flex">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            <span className="text-[11px] leading-snug text-muted-foreground/70">
              Moteur en marche · mode suggestion
            </span>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 sm:py-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
