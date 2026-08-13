import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type ConfigView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { Ingestion } from "./Ingestion";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, getConfig: vi.fn(), updateConfig: vi.fn() } };
});

const config = (over: Partial<ConfigView> = {}): ConfigView => ({ ...demo.config, ...over });

describe("Ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockResolvedValue(config({ polling_interval_seconds: "60" }));
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
  });

  it("reflète l'état du polling et l'intervalle enregistré", async () => {
    renderWithToast(<Ingestion />);
    expect(await screen.findByDisplayValue("60")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Polling activé" })).toBeChecked();
  });

  it("un moteur en pause l'annonce, marqueur compris", async () => {
    vi.mocked(Api.getConfig).mockResolvedValue(config({ polling_enabled: "false" }));
    renderWithToast(<Ingestion />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Polling activé" })).not.toBeChecked(),
    );
    expect(screen.getByText("Désactivé")).toBeInTheDocument();
  });

  it("n'enregistre que ses deux clés", async () => {
    renderWithToast(<Ingestion />);
    await screen.findByDisplayValue("60");
    await userEvent.click(screen.getByRole("switch", { name: "Polling activé" }));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Object.keys(vi.mocked(Api.updateConfig).mock.calls[0][0]).sort()).toEqual([
      "polling_enabled",
      "polling_interval_seconds",
    ]);
    expect(vi.mocked(Api.updateConfig).mock.calls[0][0]).toMatchObject({ polling_enabled: false });
  });

  it("dit que l'intervalle s'applique IMMÉDIATEMENT — les autres écrans promettent l'inverse", async () => {
    // `routes/config.py` reprogramme le job APScheduler à l'enregistrement. C'est le seul
    // réglage du produit dans ce cas : une promesse uniforme mais fausse vaudrait moins.
    renderWithToast(<Ingestion />);
    await screen.findByDisplayValue("60");
    expect(screen.getByText(/Appliqué IMMÉDIATEMENT à l'enregistrement/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText(/Intervalle de polling/));
    await userEvent.type(screen.getByLabelText(/Intervalle de polling/), "120");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(await screen.findByText(/appliqué immédiatement/)).toBeInTheDocument();
  });
  it("une lecture en échec n'enregistre RIEN, même formulaire modifié", async () => {
    // Le formulaire n'est jamais vide : il porte ses propres défauts. Enregistrer par-dessus
    // une lecture ratée écraserait la configuration réelle par eux. On SALIT le formulaire,
    // sinon le bouton est déjà inerte faute de modification et le garde-fou n'est pas exercé.
    vi.mocked(Api.getConfig).mockRejectedValue(new Error("502 Bad Gateway"));
    renderWithToast(<Ingestion />);
    expect(await screen.findByText(/Impossible de charger la configuration/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: "Polling activé" }));
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    expect(Api.updateConfig).not.toHaveBeenCalled();
  });
});
