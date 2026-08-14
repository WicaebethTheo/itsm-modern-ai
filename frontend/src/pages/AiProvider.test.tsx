import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type LlmTestResult } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { AiProvider } from "./AiProvider";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, getConfig: vi.fn(), updateConfig: vi.fn(), testLlm: vi.fn() },
  };
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
  // Le test du fournisseur : un VRAI appel, pas un ping. C'est le seul écran où l'on peut
  // apprendre qu'un modèle repond mais ne rend rien d'exploitable — panne invisible partout
  // ailleurs, puisque le moteur continue de tourner en envoyant tout « à trier ».
  describe("test du fournisseur", () => {
    function verdict(over: Partial<LlmTestResult> = {}): LlmTestResult {
      return {
        ok: true,
        stage: "ok",
        provider: "mistral",
        model: "mistral-large-latest",
        latency_ms: 940,
        prompt_tokens: 268,
        completion_tokens: 96,
        cost_eur: 0.0011,
        category: 1,
        priority: 3,
        confidence: 0.82,
        error: null,
        ...over,
      };
    }

    it("rend le verdict, la latence et ce que le modèle a proposé", async () => {
      vi.mocked(Api.testLlm).mockResolvedValue(verdict());
      renderWithToast(<AiProvider />);
      await screen.findByText("Actif");
      await userEvent.click(screen.getByRole("button", { name: "Tester le fournisseur" }));

      expect(await screen.findByText(/sa sortie est exploitable/)).toBeInTheDocument();
      expect(screen.getByText(/940 ms/)).toBeInTheDocument();
      expect(screen.getByText(/la priorité 3/)).toBeInTheDocument();
    });

    it("distingue « ne répond pas » de « répond mais sortie inexploitable »", async () => {
      vi.mocked(Api.testLlm).mockResolvedValue(
        verdict({ ok: false, stage: "invalid_output", error: "JSON non parsable" }),
      );
      renderWithToast(<AiProvider />);
      await screen.findByText("Actif");
      await userEvent.click(screen.getByRole("button", { name: "Tester le fournisseur" }));

      expect(await screen.findByText(/n'est pas exploitable/)).toBeInTheDocument();
      // Le remède n'est PAS le même que pour une clé refusée : on ne doit pas envoyer
      // l'exploitant vérifier son URL et sa clé alors qu'elles fonctionnent.
      expect(screen.queryByText(/vérifiez l'URL de base/)).not.toBeInTheDocument();
      expect(screen.getByText("JSON non parsable")).toBeInTheDocument();
    });

    // Le moteur teste ce qu'il a EN BASE : proposer le test sur un formulaire modifié
    // rendrait un verdict qui ne porte pas sur ce que l'admin vient de saisir.
    it("refuse de tester tant que le formulaire n'est pas enregistré", async () => {
      renderWithToast(<AiProvider />);
      await screen.findByText("Actif");
      await userEvent.click(screen.getByRole("button", { name: /OpenAI/ }));

      expect(screen.getByRole("button", { name: "Tester le fournisseur" })).toBeDisabled();
      expect(screen.getByText(/Enregistrez d'abord/)).toBeInTheDocument();
      expect(Api.testLlm).not.toHaveBeenCalled();
    });

    it("un échec réseau du test s'affiche sans casser la page", async () => {
      vi.mocked(Api.testLlm).mockRejectedValue(new Error("API 503"));
      renderWithToast(<AiProvider />);
      await screen.findByText("Actif");
      await userEvent.click(screen.getByRole("button", { name: "Tester le fournisseur" }));
      expect(await screen.findByText(/Échec du test/)).toBeInTheDocument();
    });
  });
});
