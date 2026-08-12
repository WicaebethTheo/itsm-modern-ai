import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api } from "@/lib/api";
import { demo } from "@/lib/demo";
import { Layout } from "./Layout";

/**
 * La topbar est le seul endroit de la console où l'on voit, d'un coup d'œil, si le moteur
 * parle encore à GLPI — et c'est aussi le seul objet « compte » du produit. Elle n'avait
 * AUCUN test : `Layout` est mocké partout ailleurs (cf. RequireAuth.test.tsx), donc son
 * JSX ne passait sous aucun assert tout en pesant au dénominateur de la couverture.
 */

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      health: vi.fn(),
      version: vi.fn(),
      getLicense: vi.fn(),
      getConfig: vi.fn(),
      me: vi.fn(),
      logout: vi.fn(),
    },
  };
});

/** Licence Community / Supporter : l'édition se lit sur `features[].active`, comme Store. */
function license(active: boolean) {
  return {
    ...demo.license,
    features: demo.license.features.map((f) => ({ ...f, entitled: active, active })),
  };
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<div>CONTENU</div>} />
        </Route>
        <Route path="/account" element={<div>PAGE-COMPTE</div>} />
        <Route path="/login" element={<div>PAGE-CONNEXION</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** La topbar seule : la sidebar porte des libellés homonymes (« Supporter »). */
function topbar() {
  return screen.getByRole("banner");
}

/** Ouvre le menu de compte et rend le `user-event` qui a servi (pour la suite du test). */
async function openMenu() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { expanded: false }));
  return user;
}

describe("Layout — topbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.health).mockResolvedValue(demo.health);
    vi.mocked(Api.version).mockResolvedValue({ ...demo.version, update_available: false });
    vi.mocked(Api.getLicense).mockResolvedValue(license(false));
    vi.mocked(Api.getConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.me).mockResolvedValue(demo.me);
    vi.mocked(Api.logout).mockResolvedValue({
      authenticated: false,
      auth_configured: true,
      setup_required: false,
    });
  });

  it("affiche l'état GLPI en UN SEUL nœud texte (contrat de l'E2E)", async () => {
    // `frontend/e2e/login.spec.ts` fait `getByText("GLPI 10.0.18")` : scinder ce libellé
    // en plusieurs nœuds (pastille + texte, fragments) casserait le parcours critique.
    renderLayout();
    const chip = await screen.findByText(`GLPI ${demo.health.glpi.version}`);
    expect(chip).toBeInTheDocument();
    expect(chip.childElementCount).toBe(0);
  });

  it("colore l'état GLPI en destructif quand le moteur ne le joint plus", async () => {
    vi.mocked(Api.health).mockResolvedValue({
      ...demo.health,
      glpi: { configured: true, reachable: false, version: null },
    });
    renderLayout();
    const chip = await screen.findByText("GLPI injoignable");
    expect(chip.className).toContain("text-destructive");
  });

  it("affiche un chip d'édition NEUTRE en Community, et il mène à la page Supporter", async () => {
    renderLayout();
    const chip = await screen.findByText("Community");
    expect(chip).toHaveAttribute("href", "/store");
    // Neutre : il ne doit plus capter le regard avant l'état GLPI.
    expect(chip.className).toContain("text-muted-foreground");
    expect(chip.className).not.toContain("accent-purple");
    // « Supporter » ne subsiste que comme entrée de sidebar, plus comme bouton violet.
    expect(within(topbar()).queryByText("Supporter")).not.toBeInTheDocument();
  });

  it("passe le chip d'édition en violet dès qu'une fonctionnalité est active", async () => {
    vi.mocked(Api.getLicense).mockResolvedValue(license(true));
    renderLayout();
    const chip = await within(await screen.findByRole("banner")).findByText("Supporter");
    expect(chip.className).toContain("accent-purple");
    expect(screen.queryByText("Community")).not.toBeInTheDocument();
  });

  it("ne montre plus ni badge Docker ni version installée dans la barre", async () => {
    renderLayout();
    await screen.findByText("Community"); // la barre est chargée
    expect(within(topbar()).queryByText("Docker")).not.toBeInTheDocument();
    expect(within(topbar()).queryByText(`v${demo.version.current}`)).not.toBeInTheDocument();
  });

  it("n'affiche que le badge de mise à jour quand une version est disponible", async () => {
    vi.mocked(Api.version).mockResolvedValue({
      ...demo.version,
      update_available: true,
      latest: "9.9.9",
    });
    renderLayout();
    expect(await screen.findByText("↑ v9.9.9")).toBeInTheDocument();
  });

  it("ne suffixe plus le tableau de bord de « derniers 14 jours » (les compteurs sont des cumuls)", async () => {
    renderLayout();
    expect(await screen.findByRole("heading", { name: "Tableau de bord" })).toBeInTheDocument();
    expect(screen.queryByText(/14 jours/)).not.toBeInTheDocument();
  });
});

describe("Layout — menu de compte", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.health).mockResolvedValue(demo.health);
    vi.mocked(Api.version).mockResolvedValue({ ...demo.version, update_available: false });
    vi.mocked(Api.getLicense).mockResolvedValue(license(false));
    vi.mocked(Api.getConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.me).mockResolvedValue(demo.me);
    vi.mocked(Api.logout).mockResolvedValue({
      authenticated: false,
      auth_configured: true,
      setup_required: false,
    });
  });

  it("reste fermé tant qu'on ne le demande pas", async () => {
    renderLayout();
    await screen.findByText(`GLPI ${demo.health.glpi.version}`);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("ouvre l'identité, les réglages, la version et la déconnexion", async () => {
    renderLayout();
    await openMenu();
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByText(demo.me.email)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Compte & sécurité/ })).toBeInTheDocument();
    expect(screen.getByText("Langue")).toBeInTheDocument();
    expect(screen.getByText("Thème")).toBeInTheDocument();
    expect(screen.getByText(`v${demo.version.current} · Docker`)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Déconnexion/ })).toBeInTheDocument();
  });

  it("mène à « Compte & sécurité » et se referme au passage", async () => {
    renderLayout();
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: /Compte & sécurité/ }));
    expect(await screen.findByText("PAGE-COMPTE")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("se referme sur Échap", async () => {
    renderLayout();
    const user = await openMenu();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("se referme quand on désigne autre chose", async () => {
    renderLayout();
    const user = await openMenu();
    await user.click(screen.getByRole("heading", { name: "Tableau de bord" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("déconnecte et renvoie à l'écran de connexion", async () => {
    renderLayout();
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: /Déconnexion/ }));
    expect(await screen.findByText("PAGE-CONNEXION")).toBeInTheDocument();
    expect(Api.logout).toHaveBeenCalled();
  });

  it("retombe sur « Administrateur » si /api/auth/me échoue — la barre ne casse jamais", async () => {
    vi.mocked(Api.me).mockRejectedValue(new Error("401"));
    renderLayout();
    await openMenu();
    expect(screen.getAllByText("Administrateur").length).toBeGreaterThan(0);
    // Aucune adresse inventée : la ligne email disparaît, elle ne ment pas.
    expect(screen.queryByText(demo.me.email)).not.toBeInTheDocument();
    // Et le reste du menu fonctionne toujours.
    expect(screen.getByRole("menuitem", { name: /Déconnexion/ })).toBeInTheDocument();
  });
});
