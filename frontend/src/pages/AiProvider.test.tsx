import { Api } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiProvider } from "./AiProvider";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, getConfig: vi.fn(), updateConfig: vi.fn() } };
});

describe("AiProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Défaut souverain : Mistral EU sélectionné.
    vi.mocked(Api.getConfig).mockResolvedValue({ ...demo.config, llm_provider: "mistral" });
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
  });

  it("présente Mistral EU comme fournisseur actif par défaut", async () => {
    renderWithToast(<AiProvider />);
    // « Actif » (tag unique) marque le fournisseur sélectionné ; le libellé Mistral
    // apparaît à plusieurs endroits (bouton + sous-titre), donc on l'assoie autrement.
    expect(await screen.findByText("Actif")).toBeInTheDocument();
    expect(screen.getAllByText("Mistral EU (souverain)").length).toBeGreaterThan(0);
  });

  it("avertit (hors UE) quand on sélectionne un fournisseur non souverain", async () => {
    renderWithToast(<AiProvider />);
    await screen.findByText("Actif");
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    expect(await screen.findByText(/hors UE \(non-souverain\)/)).toBeInTheDocument();
  });

  it("enregistre le fournisseur choisi (updateConfig llm_provider)", async () => {
    renderWithToast(<AiProvider />);
    await screen.findByText("Actif");
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Api.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ llm_provider: "openai" }),
    );
    expect(await screen.findByText("Fournisseur IA enregistré.")).toBeInTheDocument();
  });
});
