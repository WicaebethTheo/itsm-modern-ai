import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type ConfigView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { Guardrails } from "./Guardrails";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, getConfig: vi.fn(), updateConfig: vi.fn() } };
});

/** La page renvoie vers /cost (« Voir la consommation ») → contexte routeur requis. */
function renderPage() {
  return renderWithToast(
    <MemoryRouter>
      <Guardrails />
    </MemoryRouter>,
  );
}

const config = (over: Partial<ConfigView> = {}): ConfigView => ({ ...demo.config, ...over });

/**
 * Attend que la config soit RÉELLEMENT arrivée. Attendre un contrôle quelconque ne suffit
 * pas : le formulaire est rendu dès le premier passage avec ses défauts locaux, et une
 * assertion posée là passe avant même la réponse du serveur.
 */
const attendreChargement = () => screen.findByDisplayValue("0.7");

describe("Garde-fous", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockResolvedValue(config());
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
  });

  it("les champs portent la VALEUR enregistrée, pas un placeholder", async () => {
    renderPage();
    await attendreChargement();
    // Un placeholder gris clair ne se distingue pas d'une suggestion : l'admin ne pouvait
    // pas savoir si le seuil affiché était le sien ou celui du produit.
    expect(screen.getByLabelText(/Seuil de confiance/)).toHaveValue(0.7);
  });

  it("n'enregistre QUE ses trois clés — pas les dix-sept de l'ancienne page", async () => {
    // C'est tout l'intérêt du découpage : `ConfigUpdate` est un patch, et un écran qui
    // renvoie des clés qu'il n'affiche pas écrase ce qu'un autre onglet vient d'y changer.
    renderPage();
    await attendreChargement();
    await userEvent.clear(screen.getByLabelText(/Seuil de confiance/));
    await userEvent.type(screen.getByLabelText(/Seuil de confiance/), "0.9");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Object.keys(vi.mocked(Api.updateConfig).mock.calls[0][0]).sort()).toEqual([
      "confidence_threshold",
      "cost_cap_eur_per_day",
      "llm_retries",
    ]);
  });

  it("annonce « Tout est enregistré. » puis « Modifications non enregistrées. »", async () => {
    renderPage();
    await attendreChargement();
    expect(screen.getByText("Tout est enregistré.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Tentatives LLM/), "3");
    expect(screen.getByText("Modifications non enregistrées.")).toBeInTheDocument();
  });

  it("le plafond de coût dit ce qui se passe une fois atteint et renvoie vers les coûts", async () => {
    renderPage();
    await attendreChargement();
    expect(screen.getByText(/suspend les appels LLM facturables/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voir la consommation" })).toHaveAttribute(
      "href",
      "/cost",
    );
  });

  it("le seuil de confiance explique le repli « à trier » avec des repères chiffrés", async () => {
    renderPage();
    await attendreChargement();
    expect(screen.getByText(/AUCUNE écriture/)).toBeInTheDocument();
    expect(screen.getByText(/0,5 permissif · 0,7 équilibré · 0,9 strict/)).toBeInTheDocument();
  });

  it("un champ VIDÉ n'écrit rien plutôt que d'imposer un zéro", async () => {
    // Vider « plafond » puis enregistrer ne doit pas poser `cost_cap_eur_per_day: 0`, qui
    // signifie « aucun plafond, dépense non bornée » — l'exact inverse d'une absence de saisie.
    renderPage();
    await attendreChargement();
    await userEvent.clear(screen.getByLabelText(/Plafond de coût/));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(Api.updateConfig).mock.calls[0][0]).not.toHaveProperty("cost_cap_eur_per_day");
  });

  it("prévient quand la configuration n'a pas pu être lue, et n'enregistre pas", async () => {
    // Un formulaire qui n'a rien lu n'est pas vide : il est rempli de ses propres défauts.
    // Enregistrer écraserait la configuration réelle par eux.
    vi.mocked(Api.getConfig).mockRejectedValue(new Error("502 Bad Gateway"));
    renderPage();
    expect(await screen.findByText(/Impossible de charger la configuration/)).toBeInTheDocument();

    // ON SALIT LE FORMULAIRE. Sans ça, le bouton est déjà désactivé parce que rien n'a
    // changé : la mutation `peutEnregistrer={true}` survivait, et la moitié « n'enregistre
    // pas » du nom de ce test n'était jamais exercée.
    await userEvent.type(screen.getByLabelText(/Tentatives LLM/), "3");
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    expect(Api.updateConfig).not.toHaveBeenCalled();
  });

  it("chaque champ a un nom accessible", async () => {
    renderPage();
    await attendreChargement();
    for (const nom of [/Seuil de confiance/, /Plafond de coût/, /Tentatives LLM/]) {
      expect(screen.getByLabelText(nom)).toBeInTheDocument();
    }
  });
});
