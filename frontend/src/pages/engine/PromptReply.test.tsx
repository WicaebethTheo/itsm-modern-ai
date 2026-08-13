import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type ConfigView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { PromptReply } from "./PromptReply";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, getConfig: vi.fn(), updateConfig: vi.fn() } };
});

const config = (over: Partial<ConfigView> = {}): ConfigView => ({ ...demo.config, ...over });

describe("Prompt & réponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockResolvedValue(
      config({ response_tone: "cordial", system_prompt: "Tu es un assistant." }),
    );
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
  });

  it("porte les valeurs enregistrées", async () => {
    renderWithToast(<PromptReply />);
    expect(await screen.findByDisplayValue("cordial")).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt système")).toHaveValue("Tu es un assistant.");
  });

  it("rappelle que modifier le prompt n'enlève aucun garde-fou", async () => {
    // Invariant produit : le code valide TOUJOURS la Décision (whitelist, seuil). Un écran
    // qui laisse réécrire les instructions du modèle doit le dire, sinon il laisse croire
    // que le prompt est la dernière barrière.
    renderWithToast(<PromptReply />);
    await screen.findByDisplayValue("cordial");
    expect(screen.getByText(/n'enlève aucun garde-fou/)).toBeInTheDocument();
  });

  it("compte les caractères et signale l'emploi du prompt par défaut", async () => {
    renderWithToast(<PromptReply />);
    await screen.findByDisplayValue("cordial");
    expect(screen.getByText(/19 \/ 8000 caractères/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Réinitialiser au défaut" }));
    expect(screen.getByText(/0 \/ 8000 caractères — \(défaut utilisé\)/)).toBeInTheDocument();
  });

  it("envoie les quatre champs, chaîne vide comprise", async () => {
    // Ici une chaîne vide est une VALEUR (« pas de signature », « prompt par défaut ») :
    // l'omettre rendrait impossible d'effacer une consigne déjà enregistrée.
    renderWithToast(<PromptReply />);
    await screen.findByDisplayValue("cordial");
    await userEvent.click(screen.getByRole("button", { name: "Réinitialiser au défaut" }));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(Api.updateConfig).mock.calls[0][0]).toEqual({
      response_tone: "cordial",
      assistant_name: demo.config.assistant_name,
      routing_rules: demo.config.routing_rules,
      // Le prompt vidé PART, il n'est pas omis : c'est ce qui rétablit le défaut.
      system_prompt: "",
    });
  });

  it("le prompt système a un nom accessible malgré l'absence de <label> visible", async () => {
    renderWithToast(<PromptReply />);
    await screen.findByDisplayValue("cordial");
    expect(screen.getByLabelText("Prompt système")).toBeInTheDocument();
  });
});
