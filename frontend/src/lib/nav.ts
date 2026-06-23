// Registre de navigation — source unique pour la sidebar ET le titre de la topbar.
// Bilingue (fr/en). Icônes uniquement sur « Opération » (fidèle à la maquette).
// Les chemins `to` sont stables (liés au routeur).

export type IconName = "grid" | "clock" | "log" | "list";

export interface NavItem {
  to: string;
  fr: string;
  en: string;
  icon?: IconName;
  end?: boolean;
}

export interface NavSection {
  fr: string;
  en: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    fr: "Opération",
    en: "Operation",
    items: [
      { to: "/", fr: "Tableau de bord", en: "Dashboard", icon: "grid", end: true },
      { to: "/status", fr: "Statut", en: "Status", icon: "clock" },
      { to: "/journal", fr: "Journaux", en: "Logs", icon: "log" },
      { to: "/glpi", fr: "Connexion GLPI", en: "GLPI connection", icon: "list" },
    ],
  },
  {
    fr: "Configuration",
    en: "Configuration",
    items: [
      { to: "/scope", fr: "Règles métier", en: "Business rules" },
      { to: "/technicians", fr: "Techniciens", en: "Technicians" },
      { to: "/groups", fr: "Groupes", en: "Groups" },
      { to: "/ai-provider", fr: "Fournisseur IA", en: "AI provider" },
      { to: "/engine", fr: "Moteur", en: "Engine" },
      { to: "/privacy", fr: "Confidentialité (DPO)", en: "Privacy (DPO)" },
      { to: "/cost", fr: "Coûts & quotas", en: "Cost & quotas" },
    ],
  },
  {
    fr: "Avancé",
    en: "Advanced",
    items: [
      { to: "/sandbox", fr: "Bac à sable", en: "Sandbox" },
      { to: "/store", fr: "Supporter", en: "Supporter" },
      { to: "/automations", fr: "Automations", en: "Automations" },
      { to: "/debug", fr: "Développement", en: "Development" },
    ],
  },
];

const ALL = NAV.flatMap((s) => s.items);

/** Retrouve l'entrée de nav correspondant à un pathname (pour le titre de la topbar). */
export function navByPath(pathname: string): NavItem | undefined {
  if (pathname === "/" || pathname === "") return ALL.find((i) => i.to === "/");
  // Plus long préfixe d'abord pour éviter que "/" matche tout.
  return ALL.filter((i) => i.to !== "/")
    .sort((a, b) => b.to.length - a.to.length)
    .find((i) => pathname.startsWith(i.to));
}
