import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Anomaly, Api, type DayPoint, type Metrics, type OperationalView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { Dashboard } from "./Dashboard";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      metrics: vi.fn(),
      operationalMetrics: vi.fn(),
      decisions: vi.fn(),
    },
  };
});

/** La page contient des <Link> (Statut / Journal) : routeur mémoire obligatoire. */
function renderPage(ui: ReactElement = <Dashboard />) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

/** Série 14 jours entièrement à zéro — ce que renvoie RÉELLEMENT un moteur sans données. */
function zeroSeries(): DayPoint[] {
  return demo.metrics.series.map((d) => ({ date: d.date, accepted: 0, a_trier: 0 }));
}

function metricsWith(patch: Partial<Metrics>): Metrics {
  return { ...demo.metrics, ...patch };
}

function opWith(patch: Partial<NonNullable<OperationalView["metrics"]>>): OperationalView {
  const base = demo.operational.metrics as NonNullable<OperationalView["metrics"]>;
  return { available: true, detail: "", metrics: { ...base, ...patch } };
}

/** Promesse qu'on résout à la main : sert à observer l'état de CHARGEMENT. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.metrics).mockResolvedValue(demo.metrics);
    vi.mocked(Api.operationalMetrics).mockResolvedValue(demo.operational);
    vi.mocked(Api.decisions).mockResolvedValue(demo.decisions);
  });

  it("affiche les KPI et cadre les compteurs comme des cumuls", async () => {
    renderPage();
    // Separateur de milliers dependant de l'ICU (espace fine insecable) -> regex tolerante.
    expect(await screen.findByText(/^1\s?284$/)).toBeInTheDocument();
    expect(screen.getByText(/cumulés depuis la mise en service/)).toBeInTheDocument();
    // Le badge « live » mentait : la page ne se rafraîchit pas toute seule.
    expect(screen.queryByText("live")).not.toBeInTheDocument();
  });

  describe("coût LLM", () => {
    it("formate le montant à 2 décimales et le situe par rapport au plafond", async () => {
      vi.mocked(Api.metrics).mockResolvedValue(
        metricsWith({ cost_eur_last_24h: 1.8325, cost_cap_eur_per_day: 5 }),
      );
      renderPage();
      // Le backend arrondit à 4 décimales : « 1.8325 € » brut n'est pas lisible.
      expect(await screen.findByText("1,83 €")).toBeInTheDocument();
      expect(screen.getByText("37% du plafond")).toBeInTheDocument();
    });

    it("dit « sans plafond » quand le plafond vaut 0", async () => {
      vi.mocked(Api.metrics).mockResolvedValue(metricsWith({ cost_cap_eur_per_day: 0 }));
      renderPage();
      expect(await screen.findByText("sans plafond")).toBeInTheDocument();
      expect(screen.getByText("aucun plafond configuré")).toBeInTheDocument();
    });

    it("alerte en rouge au dépassement du plafond", async () => {
      vi.mocked(Api.metrics).mockResolvedValue(
        metricsWith({ cost_eur_last_24h: 6, cost_cap_eur_per_day: 5 }),
      );
      renderPage();
      const tag = await screen.findByText("120% du plafond");
      expect(tag).toHaveClass("text-destructive");
    });
  });

  it("rejoue les trois chargements au clic sur « Rafraîchir »", async () => {
    renderPage();
    const btn = await screen.findByRole("button", { name: /Rafraîchir/ });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    await waitFor(() => {
      expect(Api.metrics).toHaveBeenCalledTimes(2);
      expect(Api.operationalMetrics).toHaveBeenCalledTimes(2);
      expect(Api.decisions).toHaveBeenCalledTimes(2);
    });
  });

  it("ne télécharge que les décisions affichées (8), pas les 500 du journal", async () => {
    renderPage();
    await screen.findByText("Journal des décisions");
    expect(Api.decisions).toHaveBeenCalledWith(8);
  });

  describe("tendance 14 jours — quatre états distincts", () => {
    it("montre un squelette pendant le chargement, pas « aucun ticket »", async () => {
      const d = deferred<Metrics>();
      vi.mocked(Api.metrics).mockReturnValue(d.promise);
      const { container } = renderPage();
      expect(screen.queryByText(/Aucun ticket analysé/)).not.toBeInTheDocument();
      expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
      d.resolve(demo.metrics);
      await screen.findByText("Tendance sur 14 jours");
    });

    it("signale l'erreur au lieu d'un état vide trompeur", async () => {
      vi.mocked(Api.metrics).mockRejectedValue(new Error("502 Bad Gateway"));
      renderPage();
      expect(await screen.findByText(/Tendance indisponible/)).toBeInTheDocument();
      expect(screen.queryByText(/Aucun ticket analysé/)).not.toBeInTheDocument();
    });

    it("rend le VRAI état vide quand les 14 points sont à zéro", async () => {
      vi.mocked(Api.metrics).mockResolvedValue(metricsWith({ series: zeroSeries() }));
      renderPage();
      expect(await screen.findByText(/Aucun ticket analysé sur 14 jours/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /état du moteur/ })).toHaveAttribute(
        "href",
        "/status",
      );
    });
  });

  describe("motifs « à trier »", () => {
    it("traduit les motifs et donne compte + part", async () => {
      vi.mocked(Api.metrics).mockResolvedValue(
        metricsWith({
          a_trier: 300,
          by_reason: { accepted: 700, low_confidence: 200, llm_error: 100 },
        }),
      );
      renderPage();
      expect(await screen.findByText("Confiance sous le seuil")).toBeInTheDocument();
      expect(screen.getByText("Erreur du fournisseur IA")).toBeInTheDocument();
      expect(screen.getByText(/200 · 67%/)).toBeInTheDocument();
      expect(screen.getByText(/100 · 33%/)).toBeInTheDocument();
      // `accepted` n'est pas un motif de refus : il n'a rien à faire dans ce panneau.
      expect(screen.queryByText("Traitée")).not.toBeInTheDocument();
    });

    it("affiche la couverture utile, servie par l'API et jusqu'ici ignorée", async () => {
      vi.mocked(Api.metrics).mockResolvedValue(metricsWith({ useful_coverage: 0.66 }));
      renderPage();
      expect(await screen.findByText(/Couverture utile 66%/)).toBeInTheDocument();
    });

    it("célèbre l'absence de motif quand rien n'est « à trier »", async () => {
      vi.mocked(Api.metrics).mockResolvedValue(
        metricsWith({ a_trier: 0, by_reason: { accepted: 10 } }),
      );
      renderPage();
      expect(await screen.findByText(/Aucun ticket « à trier »/)).toBeInTheDocument();
    });
  });

  describe("aperçu du journal", () => {
    it("est un vrai tableau avec des en-têtes (lisible au lecteur d'écran)", async () => {
      renderPage();
      expect(await screen.findByRole("columnheader", { name: "Statut" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Conf." })).toBeInTheDocument();
    });

    it("affiche la confiance en pourcentage, comme le Journal", async () => {
      renderPage();
      expect(await screen.findByText("94%")).toBeInTheDocument();
      expect(screen.queryByText("0.94")).not.toBeInTheDocument();
    });

    it("rend un état vide quand le journal est vide", async () => {
      vi.mocked(Api.decisions).mockResolvedValue([]);
      renderPage();
      expect(await screen.findByText("Aucune décision pour le moment")).toBeInTheDocument();
    });
  });

  describe("opérationnel GLPI", () => {
    it("affiche le taux de réaffectation quand GLPI le fournit", async () => {
      vi.mocked(Api.operationalMetrics).mockResolvedValue(
        opWith({ reassignment_rate: 0.12, reassignment_available: true }),
      );
      renderPage();
      expect(await screen.findByText("12%")).toBeInTheDocument();
      expect(screen.getByText("part des tickets réassignés")).toBeInTheDocument();
    });

    it("dit « n/d » (traduit) quand l'historique GLPI n'est pas lisible", async () => {
      renderPage();
      expect(await screen.findByText("n/d")).toBeInTheDocument();
      expect(screen.getByText("historique GLPI requis (Log)")).toBeInTheDocument();
    });

    it("borne la liste d'anomalies à 8 et annonce le reste", async () => {
      const anomalies: Anomaly[] = Array.from({ length: 25 }, (_, i) => ({
        ticket_id: 1000 + i,
        kind: "sla_breached",
        detail: `SLA TTR dépassé #${i}`,
        glpi_link: null,
      }));
      vi.mocked(Api.operationalMetrics).mockResolvedValue(opWith({ anomalies }));
      renderPage();
      expect(await screen.findByText("#1000")).toBeInTheDocument();
      expect(screen.getByText("#1007")).toBeInTheDocument();
      expect(screen.queryByText("#1008")).not.toBeInTheDocument();
      expect(screen.getByText(/\+ 17 autres anomalies/)).toBeInTheDocument();
    });
  });

  it("signale un GET en échec par une bannière", async () => {
    vi.mocked(Api.operationalMetrics).mockRejectedValue(new Error("503"));
    renderPage();
    expect(await screen.findByText(/Données du tableau de bord indisponibles/)).toBeInTheDocument();
  });

  it("anti-mouchard : aucun agrégat par technicien", async () => {
    renderPage();
    await screen.findByText("Journal des décisions");
    // Les noms de techniciens n'apparaissent QUE sur les lignes du journal (une décision =
    // une ligne) : aucun panneau, titre ou palmarès ne les regroupe.
    for (const h of screen.getAllByRole("heading")) {
      expect(h.textContent ?? "").not.toMatch(/technicien|agent|classement|palmarès/i);
    }
    const journal = screen.getByRole("table");
    expect(within(journal).getAllByText("Marc Lefèvre").length).toBeGreaterThan(0);
  });
});
