import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type CostView } from "@/lib/api";
import { CostQuotas } from "./CostQuotas";

// On mocke le module Api : on garde les exports réels (types…) et on remplace
// seulement la méthode réseau utilisée par la page.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, cost: vi.fn() },
  };
});

const FIXTURE: CostView = {
  cost_cap_eur_per_day: 5,
  spent_eur_last_24h: 1.83,
  pct_of_cap: 36.6,
  over_cap: false,
  llm_calls_total: 1284,
  price_input_per_mtok: 0.15,
  price_output_per_mtok: 0.6,
  currency: "EUR",
};

function renderPage() {
  return render(
    <MemoryRouter>
      <CostQuotas />
    </MemoryRouter>,
  );
}

describe("CostQuotas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("affiche la dépense, le plafond et le nombre d'appels", async () => {
    vi.mocked(Api.cost).mockResolvedValue(FIXTURE);
    renderPage();

    // Dépense « 1,83 € » (rendue dans la carte KPI et dans la jauge).
    expect(await screen.findAllByText("1,83 €")).not.toHaveLength(0);
    // Plafond « 5,00 € ».
    expect(screen.getAllByText("5,00 €")).not.toHaveLength(0);
    // Appels LLM journalisés (séparateur de milliers FR : espace insécable).
    expect(screen.getByText("1 284")).toBeInTheDocument();
    // Pourcentage du plafond arrondi.
    expect(screen.getByText("37%")).toBeInTheDocument();
    // Pas de bannière de dépassement.
    expect(screen.queryByText(/Plafond de coût journalier atteint/)).not.toBeInTheDocument();
  });

  it("affiche la bannière de dépassement quand over_cap est vrai", async () => {
    vi.mocked(Api.cost).mockResolvedValue({ ...FIXTURE, over_cap: true, pct_of_cap: 120 });
    renderPage();

    expect(await screen.findByText(/Plafond de coût journalier atteint/)).toBeInTheDocument();
    // La valeur réelle (120 %) reste exposée même si la barre est bornée à 100 %.
    expect(screen.getByText("120%")).toBeInTheDocument();
  });

  // L'action utile au moment du dépassement (relever le plafond) vivait tout en bas de
  // page, hors du champ visuel : elle doit être DANS la bannière qui annonce la panne.
  it("la bannière de dépassement porte l'action « Relever le plafond »", async () => {
    vi.mocked(Api.cost).mockResolvedValue({ ...FIXTURE, over_cap: true, pct_of_cap: 120 });
    renderPage();

    const banniere = await screen.findByText(/Plafond de coût journalier atteint/);
    const bouton = screen.getByRole("button", { name: /Relever le plafond/ });
    expect(banniere.closest("div")?.contains(bouton)).toBe(true);
  });

  it("masque la jauge et affiche « Aucun plafond » quand le plafond vaut 0", async () => {
    vi.mocked(Api.cost).mockResolvedValue({
      ...FIXTURE,
      cost_cap_eur_per_day: 0,
      pct_of_cap: null,
    });
    renderPage();

    expect(await screen.findByText("Aucun plafond")).toBeInTheDocument();
    expect(screen.queryByTestId("cost-cap-bar")).not.toBeInTheDocument();
  });

  // « Aucun plafond » n'est pas une information neutre : c'est le seul réglage qui empêche
  // une facture LLM de filer.
  it("AVERTIT quand aucun plafond n'est défini, et propose d'en définir un", async () => {
    vi.mocked(Api.cost).mockResolvedValue({
      ...FIXTURE,
      cost_cap_eur_per_day: 0,
      pct_of_cap: null,
    });
    renderPage();

    expect(await screen.findByText(/Aucun plafond de coût/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Définir un plafond/ })).toBeInTheDocument();
  });

  it("aucun avertissement de plafond absent quand un plafond est réglé", async () => {
    vi.mocked(Api.cost).mockResolvedValue(FIXTURE);
    renderPage();

    await screen.findByText("1 284");
    expect(screen.queryByText(/Aucun plafond de coût/)).not.toBeInTheDocument();
  });

  // Un « — » pendant le chargement était rigoureusement identique à une instance qui n'a
  // jamais appelé de LLM : deux situations opposées derrière le même écran.
  it("affiche un squelette pendant le chargement, pas des « — »", async () => {
    vi.mocked(Api.cost).mockReturnValue(new Promise<CostView>(() => {}));
    renderPage();

    expect(await screen.findAllByTestId("cost-skeleton")).toHaveLength(3);
    expect(screen.queryByText("Dépense (24 h)")).not.toBeInTheDocument();
  });

  it("affiche un état vide (pas une panne) quand aucun appel n'a été enregistré", async () => {
    vi.mocked(Api.cost).mockResolvedValue({
      ...FIXTURE,
      llm_calls_total: 0,
      spent_eur_last_24h: 0,
      pct_of_cap: 0,
    });
    renderPage();

    expect(await screen.findByText("Aucun appel LLM enregistré")).toBeInTheDocument();
    expect(screen.queryByTestId("cost-skeleton")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cost-cap-bar")).not.toBeInTheDocument();
    // Les tarifs configurés restent utiles sur une instance neuve.
    expect(screen.getByText("Tarifs configurés")).toBeInTheDocument();
  });

  // Fenêtre GLISSANTE de 24 h : sans relevé daté ni rafraîchissement manuel, l'écran ment
  // au bout de quelques minutes — bandeau de dépassement compris.
  it("date le relevé et permet de le rafraîchir à la demande", async () => {
    vi.mocked(Api.cost).mockResolvedValue(FIXTURE);
    renderPage();

    expect(await screen.findByText(/Relevé à/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Actualiser/ }));
    await waitFor(() => expect(Api.cost).toHaveBeenCalledTimes(2));
  });

  // Le Layout rend déjà le <h1> de la route : un second titre in-app faisait doublon.
  it("ne rajoute pas de titre de page (le Layout en rend déjà un)", async () => {
    vi.mocked(Api.cost).mockResolvedValue(FIXTURE);
    renderPage();

    await screen.findByText("1 284");
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    // La description, elle, reste.
    expect(screen.getByText(/Dépense LLM des dernières 24 h/)).toBeInTheDocument();
  });
});
