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
// L'ORDRE des sections répond à quatre questions distinctes, et c'est tout le classement :
//   Opération     — qu'est-ce que le moteur A FAIT ? (écrans de lecture, aucun réglage)
//   Moteur        — COMMENT se comporte-t-il ? (les garde-fous, dans l'ordre du pipeline)
//   Configuration — à QUOI a-t-il accès ? (raccordements, référentiels, conformité)
//   Avancé        — outils qu'on n'ouvre pas toutes les semaines
//
// Deux entrées ont changé de section :
//   · « Connexion GLPI » quittait mal « Opération » : on y saisit une URL, un jeton et on
//     teste — c'est un écran de RÉGLAGE. L'état de la connexion, lui, est déjà porté par le
//     chip de la topbar et par la page Statut, qui sont, eux, des écrans de lecture.
//   · « Coûts & quotas » rejoint « Opération » : la page le dit elle-même en pied d'écran,
//     « le plafond et les tarifs se règlent dans Moteur, cette page est en lecture seule ».
//     Elle observe une dépense ; elle ne configure rien.
//
// POURQUOI « Moteur » est une SECTION et non plus une entrée : c'était une page de dix-sept
// contrôles répartis en sept cartes et quatre thèmes sans rapport — les bornes de sécurité du
// triage y voisinaient avec la fenêtre d'analyse d'un graphique — le tout derrière un unique
// « Enregistrer » qui réécrivait les dix-sept réglages d'un coup, donc écrasait ce qu'un
// second onglet venait de changer. Découpée, chaque page n'enregistre plus que ses propres
// clés (`ConfigUpdate` est un patch côté serveur), et l'écran qui peut ARMER une écriture
// GLPI est enfin seul sur le sien.
//
// Les entrées suivent l'ordre du pipeline de `triage.py` : ce qui filtre (Garde-fous), ce qui
// autorise à écrire (Modes), ce qui alimente (Ingestion), ce qu'on dit au modèle (Prompt).

import {
  Activity,
  EyeOff,
  FlaskConical,
  Heart,
  LayoutDashboard,
  type LucideIcon,
  MessageSquareText,
  Plug,
  ScrollText,
  ShieldCheck,
  ShieldHalf,
  Sparkles,
  Terminal,
  Timer,
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
    fr: "Moteur",
    en: "Engine",
    items: [
      { to: "/engine/guardrails", fr: "Garde-fous", en: "Guardrails", icon: ShieldCheck },
      { to: "/engine/modes", fr: "Modes d'exécution", en: "Execution modes", icon: ShieldHalf },
      { to: "/engine/ingestion", fr: "Ingestion", en: "Ingestion", icon: Timer },
      {
        to: "/engine/prompt",
        fr: "Prompt & réponse",
        en: "Prompt & reply",
        icon: MessageSquareText,
      },
    ],
  },
  {
    fr: "Configuration",
    en: "Configuration",
    items: [
      { to: "/glpi", fr: "Connexion GLPI", en: "GLPI connection", icon: Plug },
      { to: "/ai-provider", fr: "Fournisseur IA", en: "AI provider", icon: Sparkles },
      { to: "/scope", fr: "Règles métier", en: "Business rules", icon: Workflow },
      { to: "/technicians", fr: "Techniciens", en: "Technicians", icon: UserRound },
      { to: "/groups", fr: "Groupes", en: "Groups", icon: Users },
      // `EyeOff` et non un bouclier de plus : depuis que cette page PORTE les bascules de
      // masquage, son geste propre est de cacher une donnée avant qu'elle ne sorte.
      { to: "/privacy", fr: "Confidentialité (DPO)", en: "Privacy (DPO)", icon: EyeOff },
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
