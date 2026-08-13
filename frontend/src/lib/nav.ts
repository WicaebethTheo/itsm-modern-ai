// Registre de navigation — source unique pour la sidebar ET le titre de la topbar.
// Bilingue (fr/en). Les chemins `to` sont stables (liés au routeur).
//
// TOUTE entrée porte une icône. Elles ne décorent pas : la sidebar compte quinze lignes de
// texte de longueur voisine, et l'œil qui revient sur la console cherche une FORME, pas un
// mot. Quatre lignes sur quinze en portaient — les quatre premières —, ce qui donnait à la
// section « Opération » un relief que les deux autres n'avaient pas, alors qu'aucune des
// trois n'est plus importante que les autres. Icônes de `lucide-react`, déjà embarquées
// (aucun appel sortant, aucune fonte d'icônes distante) et déjà utilisées par `Setup.tsx`.
//
// L'ORDRE des sections répond à trois questions distinctes, et c'est tout le classement :
//   Opération     — qu'est-ce que le moteur A FAIT ? (écrans de lecture, aucun réglage)
//   Configuration — qu'a-t-il LE DROIT de faire ? (les garde-fous, dans l'ordre du pipeline)
//   Avancé        — outils qu'on n'ouvre pas toutes les semaines
//
// Deux entrées ont donc changé de section :
//   · « Connexion GLPI » quittait mal « Opération » : on y saisit une URL, un jeton et on
//     teste — c'est un écran de RÉGLAGE. L'état de la connexion, lui, est déjà porté par le
//     chip de la topbar et par la page Statut, qui sont, eux, des écrans de lecture.
//   · « Coûts & quotas » rejoint « Opération » : la page le dit elle-même en pied d'écran,
//     « le plafond et les tarifs se règlent dans Moteur, cette page est en lecture seule ».
//     Elle observe une dépense ; elle ne configure rien.
//
// Dans « Configuration », l'ordre suit le pipeline de triage : d'où viennent les tickets
// (GLPI), qui les lit (Fournisseur IA), sous quelles limites (Moteur), sur quel périmètre
// (Règles métier), vers qui (Techniciens, Groupes), avec quel masquage (Confidentialité),
// et ce qui se déclenche seul (Automations). C'est l'ordre du docstring de `triage.py`.

import {
  Activity,
  FlaskConical,
  Heart,
  LayoutDashboard,
  type LucideIcon,
  Plug,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  UserCog,
  UserRound,
  Users,
  Wallet,
  Workflow,
  Zap,
} from "lucide-react";

export interface NavItem {
  to: string;
  fr: string;
  en: string;
  icon: LucideIcon;
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
      { to: "/", fr: "Tableau de bord", en: "Dashboard", icon: LayoutDashboard, end: true },
      { to: "/status", fr: "Statut", en: "Status", icon: Activity },
      { to: "/journal", fr: "Journaux", en: "Logs", icon: ScrollText },
      { to: "/cost", fr: "Coûts & quotas", en: "Cost & quotas", icon: Wallet },
    ],
  },
  {
    fr: "Configuration",
    en: "Configuration",
    items: [
      { to: "/glpi", fr: "Connexion GLPI", en: "GLPI connection", icon: Plug },
      { to: "/ai-provider", fr: "Fournisseur IA", en: "AI provider", icon: Sparkles },
      { to: "/engine", fr: "Moteur", en: "Engine", icon: SlidersHorizontal },
      { to: "/scope", fr: "Règles métier", en: "Business rules", icon: Workflow },
      { to: "/technicians", fr: "Techniciens", en: "Technicians", icon: UserRound },
      { to: "/groups", fr: "Groupes", en: "Groups", icon: Users },
      { to: "/privacy", fr: "Confidentialité (DPO)", en: "Privacy (DPO)", icon: ShieldCheck },
      { to: "/automations", fr: "Automations", en: "Automations", icon: Zap },
    ],
  },
  {
    fr: "Avancé",
    en: "Advanced",
    items: [
      { to: "/sandbox", fr: "Bac à sable", en: "Sandbox", icon: FlaskConical },
      { to: "/store", fr: "Supporter", en: "Supporter", icon: Heart },
      { to: "/debug", fr: "Développement", en: "Development", icon: Terminal },
    ],
  },
];

/**
 * Pages atteignables SANS entrée de sidebar (elles ont leur propre porte d'accès) mais qui
 * doivent quand même donner un titre à la topbar.
 *
 * `/account` s'ouvre depuis le menu de compte, en haut à droite : la republier dans la
 * sidebar ajouterait une ligne de navigation permanente pour un écran qu'on visite deux
 * fois par an. Elle reste néanmoins une page à part entière — d'où sa présence ici.
 */
export const OFF_SIDEBAR: NavItem[] = [
  { to: "/account", fr: "Compte & sécurité", en: "Account & security", icon: UserCog },
];

const ALL = [...NAV.flatMap((s) => s.items), ...OFF_SIDEBAR];

/** Retrouve l'entrée de nav correspondant à un pathname (pour le titre de la topbar). */
export function navByPath(pathname: string): NavItem | undefined {
  if (pathname === "/" || pathname === "") return ALL.find((i) => i.to === "/");
  // Plus long préfixe d'abord pour éviter que "/" matche tout.
  return ALL.filter((i) => i.to !== "/")
    .sort((a, b) => b.to.length - a.to.length)
    .find((i) => pathname.startsWith(i.to));
}
