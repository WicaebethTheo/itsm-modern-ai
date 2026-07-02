import { Api, type CostView } from "@/lib/api";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
