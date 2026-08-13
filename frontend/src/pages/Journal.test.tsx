import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type DecisionEntry } from "@/lib/api";
import { Journal } from "./Journal";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, decisions: vi.fn(), annotate: vi.fn() } };
});

const decision = (over: Partial<DecisionEntry> = {}): DecisionEntry => ({
  id: 1,
  ticket_id: 48217,
  ts: "2026-05-27T10:00:00Z",
  subject: "Imprimante hors-ligne",
  accepted: true,
  reason: "accepted",
  category: 6,
  priority: 2,
  technician_id: 13,
  group_id: null,
  confidence: 0.94,
  glpi_link: "http://glpi/front/ticket.form.php?id=48217",
  annotation: "",
  ...over,
});

describe("Journal des décisions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("affiche une ligne de décision (ticket, statut, confiance)", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([decision()]);
    render(<Journal />);
    expect(await screen.findByText("#48217")).toBeInTheDocument();
    expect(screen.getByText("traité")).toBeInTheDocument();
    expect(screen.getByText("94%")).toBeInTheDocument();
  });

  it("annote une décision (Api.annotate + confirmation annoncée)", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([decision()]);
    vi.mocked(Api.annotate).mockResolvedValue(decision({ annotation: "juste" }));
    render(<Journal />);
    await screen.findByText("#48217");
    // Le champ est nommé par son ticket : « zone de texte » anonyme x500, c'était le défaut.
    await userEvent.type(screen.getByLabelText("Annotation du ticket #48217"), "juste");
    await userEvent.click(
      screen.getByRole("button", { name: "Enregistrer l'annotation du ticket #48217" }),
    );

    await waitFor(() => expect(Api.annotate).toHaveBeenCalledWith(1, "juste"));
    // La confirmation est ANNONCÉE (role=status), plus un ✓ qui masquait le nom du bouton.
    expect(await screen.findByRole("status")).toHaveTextContent("enregistrée");
  });

  it("affiche l'état vide quand il n'y a aucune décision", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([]);
    render(<Journal />);
    expect(await screen.findByText("Aucune décision pour le moment")).toBeInTheDocument();
  });

  it("montre un état de chargement, pas un tableau vide", async () => {
    // Promesse qui ne se résout pas : on reste dans l'état de chargement.
    vi.mocked(Api.decisions).mockReturnValue(new Promise(() => {}));
    render(<Journal />);
    expect(screen.getByText("Chargement…")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("n'affiche ni tableau ni état vide quand le chargement échoue", async () => {
    vi.mocked(Api.decisions).mockRejectedValue(new Error("boom"));
    render(<Journal />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Aucune décision pour le moment")).not.toBeInTheDocument();
  });

  it("traduit le motif de refus au lieu d'afficher la clé anglaise", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([
      decision({ accepted: false, reason: "technician_not_in_whitelist" }),
    ]);
    render(<Journal />);
    expect(await screen.findByText("Technicien hors périmètre")).toBeInTheDocument();
    expect(screen.queryByText("technician_not_in_whitelist")).not.toBeInTheDocument();
  });

  it("distingue un moteur empêché (rouge) d'un garde-fou (ambre)", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([
      decision({ id: 1, ticket_id: 1, accepted: false, reason: "llm_error" }),
      decision({ id: 2, ticket_id: 2, accepted: false, reason: "low_confidence" }),
    ]);
    render(<Journal />);
    expect((await screen.findByText("Erreur du fournisseur IA")).className).toContain(
      "text-destructive",
    );
    expect(screen.getByText("Confiance sous le seuil").className).toContain("text-warning");
  });

  it("dit si un repli a été assigné ou si le ticket est resté orphelin", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([
      decision({
        id: 1,
        ticket_id: 11,
        accepted: false,
        reason: "low_confidence",
        fallback_applied: true,
      }),
      decision({
        id: 2,
        ticket_id: 22,
        accepted: false,
        reason: "no_eligible_assignee",
        fallback_applied: false,
      }),
      // Moteur antérieur : champ absent → on n'affirme rien.
      decision({ id: 3, ticket_id: 33, accepted: false, reason: "low_confidence" }),
    ]);
    render(<Journal />);
    expect(await screen.findByText("repli assigné")).toBeInTheDocument();
    expect(screen.getByText("aucun destinataire")).toBeInTheDocument();
    expect(screen.getAllByText("repli assigné")).toHaveLength(1);
    expect(screen.getAllByText("aucun destinataire")).toHaveLength(1);
  });

  it("filtre par recherche (n° de ticket, sujet, motif traduit)", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([
      decision({ id: 1, ticket_id: 48217, subject: "Imprimante hors-ligne" }),
      decision({
        id: 2,
        ticket_id: 99001,
        subject: "VPN inaccessible",
        accepted: false,
        reason: "low_confidence",
      }),
    ]);
    render(<Journal />);
    await screen.findByText("#48217");

    const search = screen.getByLabelText("Rechercher dans le journal");
    await userEvent.type(search, "48217");
    expect(screen.getByText("#48217")).toBeInTheDocument();
    expect(screen.queryByText("#99001")).not.toBeInTheDocument();

    await userEvent.clear(search);
    // Recherche sur le motif TRADUIT : c'est ce que l'exploitant lit à l'écran.
    await userEvent.type(search, "confiance sous");
    expect(screen.getByText("#99001")).toBeInTheDocument();
    expect(screen.queryByText("#48217")).not.toBeInTheDocument();
  });

  it("bascule « À trier seulement » et compte les non acceptées", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([
      decision({ id: 1, ticket_id: 48217 }),
      decision({ id: 2, ticket_id: 99001, accepted: false, reason: "low_confidence" }),
    ]);
    render(<Journal />);
    await screen.findByText("#48217");
    expect(screen.getByText("2/2 affichée(s) · 1 à trier")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: "À trier seulement" }));
    expect(screen.queryByText("#48217")).not.toBeInTheDocument();
    expect(screen.getByText("#99001")).toBeInTheDocument();
    expect(screen.getByText("1/2 affichée(s) · 1 à trier")).toBeInTheDocument();
  });

  // Délai explicite : la troncature ne s'exerce QUE lorsque le lot rendu atteint la limite,
  // donc ce cas doit vraiment peindre 500 lignes — ce qui se mesure autour de 3,5 s sous
  // l'instrumentation de couverture (la porte de la CI, deux à trois fois plus lente que
  // `vitest run`). 10 s laissent la marge d'une machine chargée sans porter un délai sans
  // rapport avec la mesure ; le global (20 s, vitest.config.ts) couvrirait déjà le cas,
  // l'override reste pour DIRE que ce test-ci est lent par nature. Un seul cas peint
  // 500 lignes : tout ce qui dépend de la troncature est vérifié ici, et l'ordre des
  // étapes évite de repeindre le lot (on ne vide pas la recherche avant de charger plus).
  it("tronqué : le dit, le rappelle au filtre, et ne vide pas la vue pour en charger plus", {
    timeout: 10_000,
  }, async () => {
    const page = Array.from({ length: 500 }, (_, i) =>
      decision({ id: i + 1, ticket_id: 1000 + i }),
    );
    vi.mocked(Api.decisions).mockResolvedValue(page);
    render(<Journal />);
    await screen.findByText("#1000");
    expect(Api.decisions).toHaveBeenCalledWith(500);
    expect(
      screen.getByText("Seules les 500 décisions les plus récentes sont affichées."),
    ).toBeInTheDocument();
    // « 500/500 · 43 à trier » se lit comme un TOTAL : le compteur doit dire sa fenêtre.
    expect(screen.getByText(/décompte limité aux 500 décisions chargées/)).toBeInTheDocument();

    // Le filtre est LOCAL : « aucun résultat » ne prouve rien au-delà de la fenêtre, et
    // la seule mention de troncature vivait après 500 lignes, là où personne ne la lit.
    const search = screen.getByLabelText("Rechercher dans le journal");
    await userEvent.type(search, "zzz");
    expect(screen.getByText("Aucun résultat pour ce filtre.")).toBeInTheDocument();
    expect(screen.getByText(/n'a porté que sur les 500 décisions chargées/)).toBeInTheDocument();

    // « En charger davantage » remplaçait TOUT le corps de la carte par « Chargement… » —
    // et donc la position de défilement de celui qui venait de lire 500 lignes. Le bouton
    // vit au pied de la carte : il reste atteignable filtre en main, inutile de le vider
    // (et de repeindre 500 lignes) pour l'exercer.
    let resolve!: (v: DecisionEntry[]) => void;
    vi.mocked(Api.decisions).mockReturnValue(new Promise((r) => (resolve = r)));
    await userEvent.click(screen.getByRole("button", { name: "En charger davantage" }));
    // Le fetcher dépend de `limit` : sans ça le clic ne relancerait rien.
    await waitFor(() => expect(Api.decisions).toHaveBeenCalledWith(1000));
    expect(screen.getByText("Aucun résultat pour ce filtre.")).toBeInTheDocument();
    expect(screen.queryByText("Chargement…")).not.toBeInTheDocument();
    expect(screen.getByText("Mise à jour de la liste…")).toBeInTheDocument();

    resolve(page.slice(0, 10));
    await waitFor(() =>
      expect(screen.queryByText("Mise à jour de la liste…")).not.toBeInTheDocument(),
    );
  });

  it("un compteur non tronqué ne s'excuse pas d'une fenêtre qui n'existe pas", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([decision()]);
    render(<Journal />);
    expect(await screen.findByText("1/1 affichée(s) · 0 à trier")).toBeInTheDocument();
    expect(screen.queryByText(/décompte limité/)).not.toBeInTheDocument();
  });

  it("relance le chargement au clic sur Rafraîchir SANS effacer le tableau", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([decision()]);
    render(<Journal />);
    await screen.findByText("#48217");

    let resolve!: (v: DecisionEntry[]) => void;
    vi.mocked(Api.decisions).mockReturnValue(new Promise((r) => (resolve = r)));
    await userEvent.click(screen.getByRole("button", { name: "Rafraîchir" }));
    await waitFor(() => expect(Api.decisions).toHaveBeenCalledTimes(2));
    // « Chargement… » pleine largeur ne vaut que pour le PREMIER chargement : sinon on
    // perd le tableau et sa position de défilement à chaque rafraîchissement.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("Chargement…")).not.toBeInTheDocument();
    // Une liste courte ne prétend pas non plus qu'il y aurait davantage à charger.
    expect(screen.queryByRole("button", { name: "En charger davantage" })).not.toBeInTheDocument();

    resolve([decision()]);
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
  });

  it("rend le tableau défilable et nomme ses colonnes", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([decision()]);
    render(<Journal />);
    const table = await screen.findByRole("table");
    expect(table.className).toContain("min-w-[880px]");
    expect(table.parentElement?.className).toContain("overflow-x-auto");
    for (const th of within(table).getAllByRole("columnheader")) {
      expect(th).toHaveAttribute("scope", "col");
    }
  });
});
