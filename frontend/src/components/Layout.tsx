import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TopbarProvider, useTopbar } from "@/components/topbar-context";
import { useResource } from "@/hooks/useResource";
import { APP_VERSION, Api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Activity,
  Bot,
  Code2,
  Cpu,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  PlugZap,
  ScrollText,
  SlidersHorizontal,
  Store as StoreIcon,
  Users,
  UsersRound,
  Workflow,
} from "lucide-react";
import { useCallback } from "react";
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
    label: "Opération",
    items: [
      { to: "/", label: "Tableau de bord", icon: LayoutDashboard, end: true },
      { to: "/status", label: "Statut", icon: Activity },
      { to: "/journal", label: "Journaux", icon: ScrollText },
      { to: "/glpi", label: "Connexion GLPI", icon: PlugZap },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/scope", label: "Règles métier", icon: SlidersHorizontal },
      { to: "/technicians", label: "Techniciens", icon: Users },
      { to: "/groups", label: "Groupes", icon: UsersRound },
      { to: "/ai-provider", label: "Fournisseur IA", icon: Bot },
      { to: "/engine", label: "Moteur", icon: Cpu },
    ],
  },
  {
    label: "Avancé",
    items: [
      { to: "/sandbox", label: "Bac à sable", icon: FlaskConical },
      { to: "/store", label: "Store", icon: StoreIcon },
      { to: "/automations", label: "Automations", icon: Workflow },
      { to: "/debug", label: "Développement", icon: Code2 },
    ],
  },
];

/** Indicateur d'état GLPI dans la topbar (pastille + libellé court). */
function GlpiIndicator() {
  const health = useResource(useCallback(() => Api.health(), []));
  const reachable = health.data?.glpi.reachable;
  const configured = health.data?.glpi.configured;
  const [color, label] = !configured
    ? ["bg-muted-foreground/50", "GLPI non configuré"]
    : reachable
      ? ["bg-success", "GLPI connecté"]
      : ["bg-destructive", "GLPI injoignable"];
  return (
    <span className="hidden items-center gap-2 text-[12px] text-muted-foreground sm:flex">
      <span className={cn("h-1.5 w-1.5 rounded-full", color)} />
      {label}
    </span>
  );
}

function Topbar({ onLogout }: { onLogout: () => void }) {
  const { header } = useTopbar();
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-5 sm:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-medium leading-tight tracking-tight">
          {header.title || "ITSM Modern AI"}
        </h1>
        {header.subtitle && (
          <p className="truncate text-[12px] leading-tight text-muted-foreground">
            {header.subtitle}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <GlpiIndicator />
        <span
          className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent-indigo text-[11px] font-semibold text-white"
          title="Administrateur"
        >
          AD
        </span>
        <ThemeToggle compact />
        <button
          type="button"
          onClick={onLogout}
          aria-label="Déconnexion"
          title="Déconnexion"
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

  async function logout() {
    await Api.logout().catch(() => undefined);
    navigate("/login");
  }

  return (
    <TopbarProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        {/* Sidebar fixe à gauche (224px), bordure droite fine. */}
        <aside className="flex w-16 shrink-0 flex-col border-r border-border bg-sidebar sm:w-56">
          <div className="flex h-12 items-center gap-2.5 border-b border-border px-3 sm:px-4">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Logo className="h-5 w-5" />
            </span>
            <span className="hidden text-[14px] font-semibold tracking-tight sm:inline">
              ITSM Modern AI
            </span>
          </div>

          <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-4 sm:px-2.5">
            {SECTIONS.map((section) => (
              <div key={section.label} className="flex flex-col gap-0.5">
                <p className="mb-1 hidden px-2.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70 sm:block">
                  {section.label}
                </p>
                {section.items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    title={label}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center justify-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors sm:justify-start",
                        isActive
                          ? "bg-primary/15 text-accent-indigo"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="hidden sm:inline">{label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="flex items-center gap-2 border-t border-border px-3 py-3">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
            <span className="hidden text-[11px] leading-snug text-muted-foreground sm:inline">
              Moteur en marche · v{APP_VERSION}
            </span>
          </div>
        </aside>

        {/* Zone principale : topbar + contenu défilant. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onLogout={logout} />
          <main className="flex-1 overflow-y-auto p-5 sm:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </TopbarProvider>
  );
}
