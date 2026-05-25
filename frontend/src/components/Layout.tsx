import {
  Activity,
  Bot,
  Cpu,
  FlaskConical,
  LayoutDashboard,
  type LucideIcon,
  PlugZap,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

// Navigation data-driven : ajouter une page = une ligne ici + une route.
const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Vue d'ensemble",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
      { to: "/status", label: "Statut", icon: Activity },
      { to: "/journal", label: "Journal", icon: ScrollText },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/glpi", label: "Connexion GLPI", icon: PlugZap },
      { to: "/ai-provider", label: "Fournisseur IA", icon: Bot },
      { to: "/engine", label: "Moteur", icon: Cpu },
      { to: "/technicians", label: "Techniciens", icon: Users },
    ],
  },
  {
    label: "Outils",
    items: [{ to: "/sandbox", label: "Sandbox", icon: FlaskConical }],
  },
];

export function Layout() {
  const navigate = useNavigate();

  async function logout() {
    await Api.logout().catch(() => undefined);
    navigate("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2 px-5 py-5">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold">ITSM Modern AI</span>
        </div>
        <nav className="flex flex-1 flex-col gap-4 px-3">
          {SECTIONS.map((section) => (
            <div key={section.label}>
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {section.label}
              </p>
              <div className="flex flex-col gap-1">
                {section.items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )
                    }
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <button
          type="button"
          onClick={logout}
          className="px-5 py-3 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          Déconnexion
        </button>
        <p className="px-5 pb-3 text-[11px] text-muted-foreground/70">
          Mode suggestion — le LLM propose, le code décide.
        </p>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
