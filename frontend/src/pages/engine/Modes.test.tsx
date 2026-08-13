import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type ConfigView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { Modes } from "./Modes";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, getConfig: vi.fn(), updateConfig: vi.fn() } };
});

function renderPage() {
  return renderWithToast(
    <MemoryRouter>
      <Modes />
    </MemoryRouter>,
  );
}

/** `window.confirm` n'existe pas dans jsdom : on l'espionne pour chaque test. */
const confirmeAvec = (reponse: boolean) => vi.spyOn(window, "confirm").mockReturnValue(reponse);

const config = (over: Partial<ConfigView> = {}): ConfigView => ({ ...demo.config, ...over });

/** Le `<select>` du mode : présent dès le premier rendu, mais avec le défaut local. */
const attendreChargement = () => screen.findByDisplayValue("0.9"); // seuil semi-auto serveur

describe("Modes d'exécution — le réglage qui ÉCRIT dans GLPI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockResolvedValue(config());
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
    vi.restoreAllMocks();
  });

  it("aucun avertissement tant que le mode reste « suggestion »", async () => {
    renderPage();
    await attendreChargement();
    expect(screen.queryByText(/modifiera/)).not.toBeInTheDocument();
  });

  it("semi_auto déclenche le bandeau d'écriture réelle, comme full_auto", async () => {
    // `domain/modes.resolve_action()` mute GLPI en semi_auto dès que la confiance passe :
    // réserver l'avertissement à full_auto laissait croire à un mode d'observation.
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "semi_auto");
    expect(screen.getByText(/modifiera réellement les tickets GLPI/)).toBeInTheDocument();
    expect(screen.getByText(/PAS un mode d'observation/)).toBeInTheDocument();
  });

  it("full_auto garde son bandeau", async () => {
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "full_auto");
    expect(screen.getByText(/sans second seuil/)).toBeInTheDocument();
  });

  it("ANNULER la confirmation n'enregistre RIEN", async () => {
    const confirm = confirmeAvec(false);
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "full_auto");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(Api.updateConfig).not.toHaveBeenCalled();
  });

  it("la confirmation ÉNONCE la conséquence, pas un « êtes-vous sûr ? »", async () => {
    const confirm = confirmeAvec(false);
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "semi_auto");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    const message = confirm.mock.calls[0][0] as string;
    expect(message).toContain("catégorie, priorité, assignation");
    expect(message).toContain("répondra au demandeur");
  });

  it("confirmée, la bascule est bien envoyée au backend", async () => {
    confirmeAvec(true);
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "full_auto");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(Api.updateConfig).mock.calls[0][0]).toMatchObject({
      execution_mode_default: "full_auto",
    });
  });

  it("aucune confirmation quand le mode ENREGISTRÉ écrit déjà", async () => {
    // On ne confirme que le FRANCHISSEMENT suggestion → écriture, pas un aller-retour
    // entre deux modes qui écrivent tous les deux.
    const confirm = confirmeAvec(true);
    vi.mocked(Api.getConfig).mockResolvedValue(config({ execution_mode_default: "semi_auto" }));
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "full_auto");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("revenir à « suggestion » ne demande aucune confirmation", async () => {
    const confirm = confirmeAvec(true);
    vi.mocked(Api.getConfig).mockResolvedValue(config({ execution_mode_default: "full_auto" }));
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "suggestion");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("la barre d'enregistrement DIT qu'une modification armerait l'écriture", async () => {
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "semi_auto");
    expect(screen.getByText(/dont le passage en écriture réelle dans GLPI/)).toBeInTheDocument();
  });

  it("le marqueur de ton de l'en-tête suit le mode choisi (neutre → ambre → rouge)", async () => {
    renderPage();
    await attendreChargement();
    const select = screen.getByLabelText("Mode par défaut");
    expect(screen.getByText("Suggestion", { selector: "span" }).className).toContain("muted");
    await userEvent.selectOptions(select, "semi_auto");
    expect(screen.getByText("Semi-auto", { selector: "span" }).className).toContain("warning");
    await userEvent.selectOptions(select, "full_auto");
    expect(screen.getByText("Full-auto", { selector: "span" }).className).toContain("destructive");
  });

  it("avertit quand le seuil semi-auto est SOUS le seuil de confiance EN VIGUEUR", async () => {
    // Le seuil de confiance vit désormais sur l'écran « Garde-fous » : l'avertissement doit
    // se fonder sur ce que le moteur applique, pas sur un brouillon d'un autre écran.
    vi.mocked(Api.getConfig).mockResolvedValue(
      config({ confidence_threshold: "0.8", auto_min_confidence_default: "0.5" }),
    );
    renderPage();
    await screen.findByDisplayValue("0.5");
    expect(screen.getByText(/il n'a aucun effet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Régler les garde-fous" })).toHaveAttribute(
      "href",
      "/engine/guardrails",
    );
  });

  it("le seuil semi-auto au-dessus du seuil de confiance n'avertit pas", async () => {
    vi.mocked(Api.getConfig).mockResolvedValue(
      config({ confidence_threshold: "0.5", auto_min_confidence_default: "0.9" }),
    );
    renderPage();
    await attendreChargement();
    expect(screen.queryByText(/il n'a aucun effet/)).not.toBeInTheDocument();
  });

  it("le mode par défaut passe par la primitive Select", async () => {
    // La copie locale de classes avait déjà perdu la largeur pleine et l'état désactivé —
    // sur le réglage qui ARME l'écriture dans GLPI.
    renderPage();
    await attendreChargement();
    expect(screen.getByLabelText("Mode par défaut").tagName).toBe("SELECT");
  });
});
