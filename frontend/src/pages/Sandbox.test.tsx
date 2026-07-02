import { Api, ApiError } from "@/lib/api";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sandbox } from "./Sandbox";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, sandbox: vi.fn() } };
});

describe("Sandbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("désactive le bouton tant que le texte est vide", () => {
    render(<Sandbox />);
    expect(screen.getByRole("button", { name: "Simuler la décision" })).toBeDisabled();
  });

  it("simule une décision et affiche le résultat (déposable + brouillon)", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue({
      accepted: true,
      reason: "accepted",
      category: 3,
      category_name: "Poste de travail",
      priority: 2,
      technician_id: 11,
      technician_name: "Sylvain Martin",
      group_id: null,
      group_name: null,
      confidence: 0.9,
      draft: "Bonjour, nous avons réinitialisé votre mot de passe.",
    });
    render(<Sandbox />);
    await userEvent.type(screen.getByRole("textbox"), "mdp refusé");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    expect(Api.sandbox).toHaveBeenCalledWith("mdp refusé");
    expect(await screen.findByText("déposable")).toBeInTheDocument();
    // Noms résolus affichés avec l'id en discrétion : « Nom (#id) ».
    expect(screen.getByText("Sylvain Martin (#11)")).toBeInTheDocument();
    expect(screen.getByText("Poste de travail (#3)")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText(/réinitialisé votre mot de passe/)).toBeInTheDocument();
  });

  it("retombe sur T#id si le nom n'est pas résolu (référentiel non scanné)", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue({
      accepted: false,
      reason: "low_confidence",
      category: 7,
      category_name: null,
      priority: 3,
      technician_id: 42,
      technician_name: null,
      group_id: null,
      group_name: null,
      confidence: 0.4,
      draft: "Demande à clarifier.",
    });
    render(<Sandbox />);
    await userEvent.type(screen.getByRole("textbox"), "xx");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));
    expect(await screen.findByText("T#42")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("affiche le message d'erreur du backend (detail.message)", async () => {
    // Depuis la centralisation dans ApiError, `message` porte déjà detail.message.
    vi.mocked(Api.sandbox).mockRejectedValue(
      new ApiError(422, { detail: { message: "Texte hors périmètre." } }),
    );
    render(<Sandbox />);
    await userEvent.type(screen.getByRole("textbox"), "blabla");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));
    expect(await screen.findByText("Texte hors périmètre.")).toBeInTheDocument();
  });
});
