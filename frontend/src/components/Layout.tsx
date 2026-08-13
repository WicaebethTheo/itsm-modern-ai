import { ChevronDown, Heart, LogOut, UserCog } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { FloatingActions } from "@/components/FloatingActions";
import { LangToggle } from "@/components/LangToggle";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Avatar } from "@/components/ui/avatar";
import { useResource } from "@/hooks/useResource";
import { Api, asBool, updateCommand, type VersionInfo } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { NAV, navByPath } from "@/lib/nav";
import { cn } from "@/lib/utils";

/** Cible de `aria-controls` : le déclencheur DÉSIGNE le panneau qu'il ouvre. */
const ACCOUNT_POPOVER_ID = "account-popover";

/**
 * Chip de compte + panneau déroulant : le seul objet « personnel » de la barre.
 *
 * Il remplace un rond dégradé purement décoratif, qui occupait la place d'un menu sans en
 * offrir un, et absorbe les trois contrôles qui traînaient à côté de lui (langue, thème,
 * déconnexion) plus la ligne de version. L'avatar n'a JAMAIS de `src` : les initiales sont
 * calculées localement — pas de Gravatar, pas d'appel sortant pour afficher une tête.
 *
 * Si `/api/auth/me` échoue (route récente, moteur en cours de démarrage, session qui vient
 * de tomber), on retombe sur « Administrateur » : la barre ne doit jamais casser pour une
 * étiquette.
 *
 * CE N'EST PAS UN `role="menu"`, ET ON NE LE PRÉTEND PLUS. Un menu ARIA est un contrat :
 * il n'expose que des `menuitem`. Or ce panneau porte un bloc d'identité, deux BASCULES de
 * réglage (langue, thème) et une ligne de version — quatre enfants qui ne sont pas des
 * commandes de menu. Sous `role="menu"`, un lecteur d'écran les escamotait purement et
 * simplement : les deux seuls réglages du produit devenaient inatteignables au clavier
 * assisté. C'est donc un POPOVER : un groupe nommé, annoncé par l'`aria-expanded` de son
 * déclencheur, dont chaque enfant garde son rôle natif (lien, bouton). Et `Escape` rend le
 * focus au déclencheur — sinon le clavier repart en haut du document.
 */
function AccountMenu({ v, onLogout }: { v: VersionInfo | null; onLogout: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const me = useResource(useCallback(() => Api.me(), []));

  const email = me.data?.email || "";
  const name = me.data?.display_name || email || t("Administrateur", "Administrator");

  // Fermeture au `pointerdown` extérieur (pas au `click` : un menu qui survit au premier
  // enfoncement de souris se referme après coup, sous le doigt) et à `Escape`.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Le focus revient d'où il vient. Sans ça, fermer au clavier éjecte l'utilisateur
      // en haut du document : il doit re-tabuler toute la barre pour rouvrir le panneau.
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const runtimeLabel = v?.runtime === "docker" ? "Docker" : t("Hôte", "Host");

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        ref={trigger}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={ACCOUNT_POPOVER_ID}
        className="flex items-center gap-2 rounded-full border border-border py-0.5 pl-0.5 pr-2 text-body text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Avatar name={name} className="size-6 text-caption" />
        <span className="hidden max-w-[9rem] truncate sm:inline">{name}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>

      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: un <fieldset> annoncerait un groupe de champs de formulaire ; ce panneau contient un lien, deux bascules et une deconnexion.
        <div
          id={ACCOUNT_POPOVER_ID}
          role="group"
          aria-label={t("Compte", "Account")}
          className="absolute right-0 top-9 z-50 w-64 rounded-lg border border-border bg-card p-1.5 shadow-lg"
        >
          <div className="px-2.5 py-1.5">
            <p className="truncate text-body font-medium text-foreground">{name}</p>
            {email ? <p className="truncate text-caption text-muted-foreground">{email}</p> : null}
          </div>
          <div className="my-1 h-px bg-border" />
          <NavLink
            to="/account"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-body text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <UserCog className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("Compte & sécurité", "Account & security")}
          </NavLink>
          <div className="my-1 h-px bg-border" />
          <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-body text-muted-foreground">
            <span>{t("Langue", "Language")}</span>
            <LangToggle />
          </div>
          <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-body text-muted-foreground">
            <span>{t("Thème", "Theme")}</span>
            <ThemeToggle compact />
          </div>
          {v ? (
            <>
              <div className="my-1 h-px bg-border" />
              {/* Fait d'installation, pas un signal d'exploitation : il descend ici plutôt
                  que d'occuper deux badges dans la barre. */}
              <p className="px-2.5 py-1 text-caption text-muted-foreground">
                {`v${v.current} · ${runtimeLabel}`}
              </p>
            </>
          ) : null}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-body text-destructive transition-colors hover:bg-destructive/10"
          >
            <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("Déconnexion", "Sign out")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * `isSupporter` vaut `null` tant que la licence n'a PAS été lue — et ce n'est pas un détail :
 * le chip d'édition ne s'affiche qu'une fois la réponse arrivée, parce qu'annoncer une
 * édition avant de l'avoir lue serait un pari, pas une information. Un simple booléen
 * aurait écrasé « inconnu » sur « Community ».
 */
function Topbar({ onLogout, isSupporter }: { onLogout: () => void; isSupporter: boolean | null }) {
  const t = useT();
  const { pathname } = useLocation();
  const item = navByPath(pathname);
  const title = item ? t(item.fr, item.en) : "ITSM Modern AI";
  const health = useResource(useCallback(() => Api.health(), []));
  const g = health.data?.glpi;
  const version = useResource(useCallback(() => Api.version(), []));
  const v = version.data;
  // Re-vérifie périodiquement (page ouverte) → l'indicateur de MAJ se met à jour seul,
  // sans recharger ni redémarrer. Le backend met le résultat en cache (TTL configurable).
  const reloadVersion = version.reload;
  useEffect(() => {
    const id = setInterval(() => reloadVersion(), 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [reloadVersion]);

  // Un SEUL nœud texte, volontairement : `frontend/e2e/login.spec.ts` fait
  // `getByText("GLPI 10.0.18")`, et une pastille-sœur ou un fragment scindé casserait la
  // correspondance. La couleur du chip porte désormais l'état — la pastille grise n'a
  // plus lieu d'être.
  const glpi = !g?.configured
    ? {
        label: t("GLPI non configuré", "GLPI not configured"),
        cls: "border-border bg-muted text-muted-foreground",
        title: t("Aucune connexion GLPI configurée", "No GLPI connection configured"),
      }
    : g.reachable
      ? {
          label: g.version ? `GLPI ${g.version}` : t("GLPI connecté", "GLPI connected"),
          cls: "border-success/30 bg-success/10 text-success",
          title: t("GLPI joignable", "GLPI reachable"),
        }
      : {
          label: t("GLPI injoignable", "GLPI unreachable"),
          cls: "border-destructive/40 bg-destructive/10 text-destructive",
          title: t(
            "GLPI ne répond pas — le triage est à l'arrêt",
            "GLPI is not responding — triage is halted",
          ),
        };

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-5 sm:px-6">
      <div className="flex min-w-0 items-baseline gap-3">
        {/* Pas de « · derniers 14 jours » ici : les compteurs du tableau de bord sont des
            CUMULS depuis la mise en service, seule la tendance porte sur 14 jours. */}
        <h1 className="truncate text-title font-medium tracking-tight">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {/* UN SEUL chip d'édition, qui mène à la page Supporter. Le bouton violet et le
            badge « Community » disaient la même chose à deux endroits — et le violet
            captait le regard avant l'état GLPI, qui est le vrai signal d'exploitation.
            En Community le chip est donc NEUTRE ; il ne redevient violet qu'une fois la
            licence active. Affiché seulement quand la licence est connue : annoncer une
            édition avant de l'avoir lue serait un pari, pas une information. */}
        {isSupporter !== null ? (
          <NavLink
            to="/store"
            title={
              isSupporter
                ? t(
                    "Édition Supporter — licence & fonctionnalités",
                    "Supporter edition — license & features",
                  )
                : t(
                    "Édition Community — devenir Supporter",
                    "Community edition — become a Supporter",
                  )
            }
            className={cn(
              "hidden items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-caption font-medium transition-colors md:flex",
              isSupporter
                ? "border-accent-purple/40 bg-accent-purple/15 text-accent-purple hover:bg-accent-purple/25"
                : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Heart
              className="h-3.5 w-3.5 shrink-0"
              fill={isSupporter ? "currentColor" : "none"}
              aria-hidden="true"
            />
            {isSupporter ? "Supporter" : "Community"}
          </NavLink>
        ) : null}
        {/* Mise à jour disponible UNIQUEMENT. La version installée n'est pas un signal :
            elle ne change qu'à une mise à jour et vit désormais dans le menu de compte. */}
        {v?.update_available ? (
          <a
            href="https://docs.itsm-modern-ai.com/update/"
            target="_blank"
            rel="noopener noreferrer"
            title={t(
              `Mise à jour disponible (v${v.latest}) — ${updateCommand(v.runtime)} — voir la doc →`,
              `Update available (v${v.latest}) — ${updateCommand(v.runtime)} — see docs →`,
            )}
            className="hidden items-center gap-1 rounded-full border border-accent-indigo/40 bg-accent-indigo/10 px-2 py-0.5 text-caption font-medium text-accent-indigo md:flex"
          >
            ↑ v{v.latest}
          </a>
        ) : null}
        {/* Le signal DOMINANT de la barre : GLPI répond-il ? En couleur sémantique. */}
        <span
          title={glpi.title}
          className={cn(
            "hidden rounded-full border px-2.5 py-0.5 text-caption font-medium md:inline",
            glpi.cls,
          )}
        >
          {glpi.label}
        </span>
        <AccountMenu v={v} onLogout={onLogout} />
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
  const pollingActif = asBool(cfg.data?.polling_enabled);

  async function logout() {
    await Api.logout().catch(() => undefined);
    navigate("/login");
  }

  // Licence lue UNE FOIS pour tout le châssis : la topbar (chip d'édition) et les widgets
  // flottants (bouton « café », masqué pour un client payant) la demandaient chacun de leur
  // côté — deux `/api/license` identiques sur chaque écran de la console.
  const license = useResource(useCallback(() => Api.getLicense(), []));
  // Édition = Supporter uniquement si une feature est réellement active (cohérent Store).
  // `null` = pas encore lue, cf. la docstring de `Topbar`.
  const isSupporter = license.data ? license.data.features.some((f) => f.active) : null;

  return (
    // Fond « backdrop » + padding : la console flotte dans un châssis centré.
    <div className="app-backdrop flex h-screen overflow-hidden p-3 sm:p-5">
      {/* Cadre du châssis. Ce conteneur n'existe QUE pour porter le contour lumineux :
          `.app-shell` est `overflow-hidden`, donc tout calque qu'on lui accrocherait pour
          déborder vers l'extérieur serait clippé net. La lumière est ici un frère du shell,
          posée dessous — seul son liseré dépasse du panneau opaque (détail dans index.css). */}
      <div className="app-shell-frame h-full w-full">
        {/* Les deux calques de rétroéclairage, DEVANT le shell dans le DOM donc PEINTS
            DESSOUS : la lumière doit sembler sourdre de derrière le panneau. La nappe
            ondulante est confinée par masque à une bande extérieure, le filet à 2 px sur
            l'arête — ni l'une ni l'autre ne peut peindre au centre (détail dans index.css). */}
        <div className="app-shell-aura" aria-hidden="true">
          {/* TROISIÈME nappe de lobes. Les deux premières sont les pseudo-éléments de
              `.app-shell-aura` (un élément n'en a que deux) ; il en faut une de plus pour
              que la teinte PARCOURE l'arc indigo/violet/bleu au lieu de faire l'aller-retour
              entre deux couleurs (détail dans index.css). Elle est ENFANT de la nappe, donc
              soumise au même masque : elle ne peut pas davantage peindre au centre. */}
          <div className="app-shell-aura-sheet" />
        </div>
        <div className="app-shell-glow" aria-hidden="true" />
        <div className="app-shell flex h-full w-full overflow-hidden rounded-xl border border-border bg-background text-foreground">
          {/* Lien d'évitement (WCAG 2.4.1). Mesuré : 21 tabulations avant d'atteindre le
              premier champ du contenu, et la barre se retabule INTÉGRALEMENT à chaque
              changement de page. Visible au focus seulement — il ne coûte rien à la souris. */}
          <a
            href="#contenu"
            className="sr-only left-4 top-4 z-50 rounded-md border border-border bg-card px-3 py-2 text-body text-foreground shadow-lg focus:not-sr-only focus:absolute"
          >
            {t("Aller au contenu", "Skip to content")}
          </a>
          {/* Sidebar fixe (224px), bordure droite fine. */}
          <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar p-3 text-ui">
            <div className="mb-2 flex items-center gap-2 px-2 py-2">
              <Logo className="h-5 w-5" />
              <span className="font-semibold tracking-tight">ITSM Modern AI</span>
            </div>

            {/* Une <nav> pour toute la barre, et une LISTE NOMMÉE par section : les
                intertitres « Opération / Configuration / Avancé » n'étaient que du texte gris
                pour un lecteur d'écran, qui annonçait quinze liens à plat. Ils étiquettent
                désormais leur groupe (`aria-labelledby`), qui annonce aussi son nombre
                d'entrées — d'où la <ul>, et non un `role="group"` posé sur une <div>. */}
            <nav aria-label={t("Navigation principale", "Main navigation")}>
              {NAV.map((section) => (
                <div key={section.en}>
                  <p
                    id={`nav-${section.en.toLowerCase()}`}
                    className="px-2 pt-4 pb-1 text-caption font-medium uppercase tracking-[0.08em] text-muted-foreground"
                  >
                    {t(section.fr, section.en)}
                  </p>
                  <ul
                    aria-labelledby={`nav-${section.en.toLowerCase()}`}
                    className="flex flex-col gap-0.5"
                  >
                    {section.items.map((it) => {
                      const Icon = it.icon;
                      return (
                        <li key={it.to}>
                          <NavLink
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
                            {/* `strokeWidth` 1.5, pas le 2 par défaut de lucide : l'icône est
                            dessinée dans un viewBox de 24 et rendue à 16 px, donc le trait
                            vaut `2 × 16/24 = 1,33 px` — il tombe À CHEVAL sur deux colonnes
                            de pixels et l'antialiasing le rend cotonneux. 1,5 donne
                            `1,5 × 16/24 = 1 px` PILE, net sur un écran 1× comme sur un 2×.
                            Les SVG dessinés à la main qui précédaient appliquaient déjà ce
                            calcul (1,7 sur 14 px = 0,99 px) ; on ne le perd pas en passant
                            à une bibliothèque. */}
                            <Icon
                              className="h-4 w-4 shrink-0"
                              strokeWidth={1.5}
                              aria-hidden="true"
                            />
                            <span className="truncate">{t(it.fr, it.en)}</span>
                          </NavLink>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>

            <div className="mt-auto flex flex-col gap-1.5 px-2 pt-3 text-caption text-muted-foreground">
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
              {/* MESURÉ, plus affirmé. Cette pastille était verte en dur : avec le polling
                  coupé, la barre annonçait « Moteur en marche » à cinq centimètres de l'écran
                  Ingestion qui affichait « Désactivé » — deux affirmations contraires sur le
                  même écran. La donnée était pourtant déjà là : `Layout` lit `/api/config`
                  pour la ligne du dessus. Tant qu'elle n'est pas lue, on n'affiche rien. */}
              {cfg.data ? (
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      pollingActif ? "bg-success" : "bg-muted-foreground/50",
                    )}
                  />
                  {pollingActif
                    ? t("Moteur en marche", "Engine running")
                    : t("Polling arrêté", "Polling stopped")}
                </div>
              ) : null}
            </div>
          </aside>

          {/* Zone principale : topbar + contenu défilant. */}
          <div className="app-content flex min-w-0 flex-1 flex-col">
            <Topbar onLogout={logout} isSupporter={isSupporter} />
            {/* `tabIndex={-1}` : sans lui, la cible d'un lien d'évitement ne PREND pas le
                focus — le lecteur d'écran continue d'annoncer la barre. `scroll-pb-20` :
                la barre d'enregistrement colle ~60 px au bas de ce conteneur, un champ
                atteint au clavier pouvait se caler exactement dessous. */}
            <main
              id="contenu"
              tabIndex={-1}
              className="flex-1 scroll-pb-20 overflow-y-auto p-5 sm:p-6"
            >
              <Outlet />
            </main>
          </div>
        </div>
      </div>
      <FloatingActions isSupporter={isSupporter === true} />
    </div>
  );
}
