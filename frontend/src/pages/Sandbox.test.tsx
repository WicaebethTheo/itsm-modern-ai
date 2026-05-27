import { Api } from "@/lib/api";
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
      priority: 2,
      technician_id: 11,
      group_id: null,
      confidence: 0.9,
      draft: "Bonjour, nous avons réinitialisé votre mot de passe.",
    });
    render(<Sandbox />);
    await userEvent.type(screen.getByRole("textbox"), "mdp refusé");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    expect(Api.sandbox).toHaveBeenCalledWith("mdp refusé");
    expect(await screen.findByText("déposable")).toBeInTheDocument();
    expect(screen.getByText("T#11")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText(/réinitialisé votre mot de passe/)).toBeInTheDocument();
  });

  it("affiche le message d'erreur du backend (detail.message)", async () => {
    vi.mocked(Api.sandbox).mockRejectedValue({
      payload: { detail: { message: "Texte hors périmètre." } },
    });
    render(<Sandbox />);
    await userEvent.type(screen.getByRole("textbox"), "blabla");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));
    expect(await screen.findByText("Texte hors périmètre.")).toBeInTheDocument();
  });
});
