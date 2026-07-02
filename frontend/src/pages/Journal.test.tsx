import { Api, type DecisionEntry } from "@/lib/api";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("annote une décision (Api.annotate + confirmation ✓)", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([decision()]);
    vi.mocked(Api.annotate).mockResolvedValue(decision({ annotation: "juste" }));
    render(<Journal />);
    await screen.findByText("#48217");
    await userEvent.type(screen.getByRole("textbox"), "juste");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(Api.annotate).toHaveBeenCalledWith(1, "juste"));
    expect(await screen.findByRole("button", { name: "✓" })).toBeInTheDocument();
  });

  it("affiche l'état vide quand il n'y a aucune décision", async () => {
    vi.mocked(Api.decisions).mockResolvedValue([]);
    render(<Journal />);
    expect(await screen.findByText("Aucune décision pour le moment")).toBeInTheDocument();
  });
});
