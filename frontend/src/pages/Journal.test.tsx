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

  // Délai explicite : la mention de plafond ne s'affiche QUE lorsque le lot rendu atteint
  // la limite, donc ce cas doit vraiment peindre 500 lignes. C'est tenable en `vitest run`
  // mais dépasse les 5 s par défaut sous l'instrumentation de couverture — préférer un
  // délai franc plutôt qu'un test affaibli qui n'exercerait plus la borne.
  it("annonce le plafond et recharge avec une limite plus large", { timeout: 30_000 }, async () => {
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

    vi.mocked(Api.decisions).mockResolvedValue(page.slice(0, 10));
    await userEvent.click(screen.getByRole("button", { name: "En charger davantage" }));
    // Le fetcher dépend de `limit` : sans ça le clic ne relancerait rien.
    await waitFor(() => expect(Api.decisions).toHaveBeenCalledWith(1000));
  });

  it("relance le chargement au clic sur Rafraîchir", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([decision()]);
    render(<Journal />);
    await screen.findByText("#48217");
    await userEvent.click(screen.getByRole("button", { name: "Rafraîchir" }));
    await waitFor(() => expect(Api.decisions).toHaveBeenCalledTimes(2));
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
