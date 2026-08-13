import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Anomaly, Api, type DayPoint, type Metrics, type OperationalView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
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
      // La carte « Réglages de cette page » ÉCRIT la configuration : sans ces mocks elle
      // partirait en erreur de lecture et le bouton resterait inerte.
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
    },
  };
});

/** La page contient des <Link> (Statut / Journal) : routeur mémoire obligatoire. */
function renderPage(ui: ReactElement = <Dashboard />) {
  // `renderWithToast` : l'enregistrement des réglages d'affichage annonce son résultat.
  return renderWithToast(<MemoryRouter>{ui}</MemoryRouter>);
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
    vi.mocked(Api.getConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
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

    it("métriques en échec : ni plafond affirmé, ni jauge peinte sous un « — »", async () => {
      vi.mocked(Api.metrics).mockRejectedValue(new Error("503 Service Unavailable"));
      renderPage();
      await screen.findByText(/Données du tableau de bord indisponibles/);
      // « aucun plafond configuré » serait une affirmation sur une valeur JAMAIS lue.
      expect(screen.queryByText("aucun plafond configuré")).not.toBeInTheDocument();
      expect(screen.queryByText(/du plafond/)).not.toBeInTheDocument();
      expect(screen.queryByText("sans plafond")).not.toBeInTheDocument();
      // Aucune jauge : une barre à 0 % se lit « zéro mesuré », pas « inconnu ».
      expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    });

    it("plafond nul : une seule jauge (la confiance), aucune jauge de plafond", async () => {
      vi.mocked(Api.metrics).mockResolvedValue(metricsWith({ cost_cap_eur_per_day: 0 }));
      renderPage();
      await screen.findByText("aucun plafond configuré");
      expect(screen.getAllByRole("progressbar")).toHaveLength(1);
      expect(screen.getByRole("progressbar", { name: "Confiance moyenne" })).toBeInTheDocument();
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
      renderPage();
      expect(screen.queryByText(/Aucun ticket analysé/)).not.toBeInTheDocument();
      // Squelette de LA TENDANCE : compter ceux de toute la page restait vert même si
      // celui-ci disparaissait (5 KPI + 4 lignes de journal en rendent déjà).
      const trend = screen.getByRole("region", { name: "Tendance sur 14 jours" });
      expect(trend.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
      d.resolve(demo.metrics);
      await waitFor(() => expect(trend.querySelectorAll(".animate-pulse").length).toBe(0));
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

    it("annonce le motif DOMINANT sur la carte KPI, pas seulement dans le panneau du bas", async () => {
      // « À trier : 300 » nu n'indique aucune action. Le panneau qui l'explique vit après la
      // tendance : hors du champ de lecture de qui découvre le nombre. La carte porte donc
      // desormais le motif majoritaire et sa part, avec un saut vers la ventilation.
      vi.mocked(Api.metrics).mockResolvedValue(
        metricsWith({
          a_trier: 300,
          by_reason: { accepted: 700, low_confidence: 200, llm_error: 100 },
        }),
      );
      renderPage();
      const raccourci = await screen.findByRole("link", {
        name: /surtout confiance sous le seuil/i,
      });
      expect(raccourci).toHaveTextContent("67%");
      // Le lien doit MENER quelque part : sans l'ancre, le raccourci ne raccourcit rien.
      expect(raccourci).toHaveAttribute("href", "#motifs-a-trier");
      expect(document.querySelector("#motifs-a-trier")).not.toBeNull();
    });

    it("n'annonce aucun motif dominant quand rien n'est « à trier »", async () => {
      // Sans ce garde-fou, `reasons[0]` sur un tableau vide rendait « surtout undefined ».
      vi.mocked(Api.metrics).mockResolvedValue(
        metricsWith({ a_trier: 0, by_reason: { accepted: 10 } }),
      );
      renderPage();
      await screen.findByText(/Couverture utile/);
      expect(screen.queryByRole("link", { name: /surtout/i })).not.toBeInTheDocument();
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

    it("journal en échec : le tableau ne reste pas réduit à ses en-têtes muets", async () => {
      vi.mocked(Api.decisions).mockRejectedValue(new Error("500 Internal Server Error"));
      renderPage();
      expect(await screen.findByText(/Journal indisponible/)).toBeInTheDocument();
      // Un journal ILLISIBLE n'est pas un journal VIDE : les deux ne doivent pas se dire
      // avec les mêmes mots.
      expect(screen.queryByText("Aucune décision pour le moment")).not.toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Statut" })).toBeInTheDocument();
    });
  });

  it("aucun ticket analysé (total = 0) : des zéros mesurés, jamais de NaN", async () => {
    vi.mocked(Api.metrics).mockResolvedValue(
      metricsWith({
        total: 0,
        accepted: 0,
        a_trier: 0,
        useful_coverage: 0,
        by_reason: {},
        avg_confidence: null,
        cost_eur_last_24h: 0,
        series: zeroSeries(),
      }),
    );
    const { container } = renderPage();
    expect(await screen.findByText(/Aucun ticket analysé sur 14 jours/)).toBeInTheDocument();
    expect(screen.getByText(/Aucun ticket « à trier »/)).toBeInTheDocument();
    expect(screen.getByText(/Couverture utile 0%/)).toBeInTheDocument();
    // `avg_confidence` nul = NON MESURÉ : « — » et aucune jauge peinte à 0 %.
    expect(
      screen.queryByRole("progressbar", { name: "Confiance moyenne" }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/NaN/);
    // Sparklines : un jour à zéro ne peint AUCUNE barre. Le plancher de 8 % rendait un
    // jour à zéro indiscernable d'un jour à un ticket.
    const bars = container.querySelectorAll<HTMLElement>(".spark span");
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar.style.height).toBe("0px");
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

  it("anti-mouchard : aucun nom hors des lignes du journal, donc aucun agrégat nominatif", async () => {
    renderPage();
    await screen.findByText("Journal des décisions");
    const journal = screen.getByRole("table");
    // L'invariant N'EST PAS « aucun titre ne contient le mot technicien » (un panneau
    // « Top routage » y échapperait sans effort) : c'est qu'AUCUN nom de personne ou de
    // groupe n'apparaît hors des lignes du journal, où une ligne = une décision.
    const names = [
      ...new Set(
        demo.decisions
          .flatMap((d) => [d.technician_name, d.group_name])
          .filter((n): n is string => !!n),
      ),
    ];
    expect(names.length).toBeGreaterThan(0);
    const horsJournal = document.body.cloneNode(true) as HTMLElement;
    for (const tbl of horsJournal.querySelectorAll("table")) tbl.remove();
    for (const name of names) {
      expect(horsJournal.textContent ?? "").not.toContain(name);
      // …et dans le journal, le nom ne paraît qu'une fois par décision qui le porte :
      // pas de total, pas de palmarès glissé dans le tableau.
      const rows = demo.decisions.filter(
        (d) => d.technician_name === name || d.group_name === name,
      ).length;
      expect(within(journal).getAllByText(name)).toHaveLength(rows);
    }
  });
});

/**
 * Ces deux réglages vivaient sous « Moteur », dans une section « Observabilité » — alors que
 * leur propre libellé disait « sans effet sur le triage ». On réglait donc la profondeur d'un
 * graphique depuis l'écran des bornes de sécurité du moteur.
 */
describe("Dashboard — réglages de la vue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.metrics).mockResolvedValue(demo.metrics);
    vi.mocked(Api.operationalMetrics).mockResolvedValue(demo.operational);
    vi.mocked(Api.decisions).mockResolvedValue(demo.decisions);
    vi.mocked(Api.getConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
  });

  it("porte les valeurs enregistrées et dit qu'elles n'affectent pas le triage", async () => {
    renderPage();
    // On attend la VALEUR, pas le champ : le formulaire est rendu dès le premier passage
    // avec ses défauts locaux, et une assertion posée là passerait avant la réponse serveur.
    await screen.findByDisplayValue("14");
    expect(screen.getByLabelText(/Fenêtre \(jours\)/)).toHaveValue(14);
    expect(screen.getByText(/sans effet sur le triage/)).toBeInTheDocument();
  });

  /**
   * Remplit un champ numérique et rend la VALEUR effectivement posée.
   *
   * `userEvent.clear()` est inopérant sur un `<input type="number">` sous jsdom (la
   * sélection n'y est pas implémentée) : `type("30")` s'AJOUTAIT donc au « 14 » déjà chargé.
   * Ce test envoyait `dashboard_window_days: 1430` — hors des bornes de l'API (`le=365`,
   * `config.py`), donc un 422 en production — et restait vert parce qu'il n'assérait que le
   * jeu de clés. Pire, c'était une course : avant l'arrivée du GET, la même séquence envoyait
   * bien 30. Un test non déterministe sur la valeur qu'il envoie, sans qu'aucune assertion
   * ne puisse le voir. `fireEvent.change` pose la valeur, sans dépendre de la sélection.
   */
  function saisirNombre(champ: HTMLElement, valeur: string) {
    fireEvent.change(champ, { target: { value: valeur } });
    return (champ as HTMLInputElement).value;
  }

  it("n'enregistre QUE ses deux clés d'affichage, et la VALEUR saisie", async () => {
    renderPage();
    await screen.findByDisplayValue("14"); // la config serveur est arrivée
    const fenetre = screen.getByLabelText(/Fenêtre \(jours\)/);
    expect(saisirNombre(fenetre, "30")).toBe("30");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    // La VALEUR autant que les clés : sans elle, le test survivait à l'envoi d'un 1430.
    expect(vi.mocked(Api.updateConfig).mock.calls[0][0]).toEqual({
      dashboard_window_days: 30,
      anomaly_new_age_hours: Number(demo.config.anomaly_new_age_hours),
    });
  });

  it("relit « Opérationnel (GLPI) », et LUI SEUL : /api/metrics ne dépend pas de ces bornes", async () => {
    // `dashboard_window_days` n'est lu que par `/api/operational-metrics`
    // (`routes/insights.py`). Relire `/api/metrics` — des compteurs CUMULÉS et une tendance
    // fixée à 14 jours côté serveur — entretenait l'idée que ces réglages pilotent tout le
    // haut de la page. C'est précisément ce que le libellé du champ laissait croire.
    renderPage();
    await screen.findByDisplayValue("14");
    expect(Api.metrics).toHaveBeenCalledTimes(1);
    expect(Api.operationalMetrics).toHaveBeenCalledTimes(1);

    saisirNombre(screen.getByLabelText(/Fenêtre \(jours\)/), "30");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.operationalMetrics).toHaveBeenCalledTimes(2));
    expect(Api.metrics).toHaveBeenCalledTimes(1);
  });

  it("un enregistrement REFUSÉ ne rafraîchit rien — le refus ne doit pas ressembler à un succès", async () => {
    // `save()` avalait l'échec et rendait `void` : la page relisait comme après un succès,
    // ce qui donne le signal visuel « ça vient de se rafraîchir » sur un réglage non écrit —
    // et tape GLPI (`/api/operational-metrics`) à chaque clic raté.
    vi.mocked(Api.updateConfig).mockRejectedValue(new Error("503 Service Unavailable"));
    renderPage();
    await screen.findByDisplayValue("14");
    saisirNombre(screen.getByLabelText(/Fenêtre \(jours\)/), "30");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Api.operationalMetrics).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
  });

  it("une lecture de configuration en échec le DIT, au lieu d'afficher ses défauts", async () => {
    vi.mocked(Api.getConfig).mockRejectedValue(new Error("502 Bad Gateway"));
    renderPage();
    expect(await screen.findByText(/Impossible de charger la configuration/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
  });
});
