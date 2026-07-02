import { Api, type LicenseView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "./Store";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      getLicense: vi.fn(),
      setLicense: vi.fn(),
      deleteLicense: vi.fn(),
      version: vi.fn(),
    },
  };
});

// Code SUPPORTER présent, non licencié : le code est installé (installed:true) mais aucune
// licence valide → l'activation par clé est proposée.
const ENT_UNLICENSED: LicenseView = {
  edition: "community",
  valid: false,
  customer: null,
  issued_at: null,
  expires_at: null,
  error: null,
  features: demo.license.features.map((f) => ({
    ...f,
    installed: true,
    entitled: false,
    active: false,
  })),
};

// Code SUPPORTER présent, licence valide → tout actif.
const ENT_ACTIVE: LicenseView = {
  edition: "supporter",
  valid: true,
  customer: "ACME Corp",
  issued_at: "2026-01-01",
  expires_at: "2027-01-01",
  error: null,
  features: demo.license.features.map((f) => ({
    ...f,
    installed: true,
    entitled: true,
    active: true,
  })),
};

// Code SUPPORTER présent, clé refusée (valid:false) → bannière d'erreur, activation visible.
const ENT_INVALID: LicenseView = { ...ENT_UNLICENSED, valid: false, error: "signature invalide" };

describe("Store (licence open-core)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.setLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.deleteLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.version).mockResolvedValue(demo.version);
  });

  it("Community : encart d'activation Supporter + features verrouillées", async () => {
    renderWithToast(<Store />);
    expect(await screen.findByText("Community")).toBeInTheDocument();
    // Sans code installé, on propose d'activer une licence Supporter (carte d'activation).
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Activer ma licence Supporter" }),
    ).toBeInTheDocument();
    // Les 3 features, toutes verrouillées.
    expect(screen.getAllByText("Supporter").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("Débloqué")).not.toBeInTheDocument();
  });

  it("Code Supporter présent : active une clé valide → licence Supporter + features débloquées", async () => {
    vi.mocked(Api.setLicense).mockResolvedValue(ENT_ACTIVE);
    vi.mocked(Api.getLicense).mockResolvedValueOnce(ENT_UNLICENSED).mockResolvedValue(ENT_ACTIVE);
    renderWithToast(<Store />);
    // Sur le code Supporter non licencié, le champ d'activation est présent.
    await screen.findByRole("textbox");

    await userEvent.type(screen.getByRole("textbox"), "JETON-VALIDE");
    await userEvent.click(screen.getByRole("button", { name: "Activer" }));

    await waitFor(() => expect(Api.setLicense).toHaveBeenCalledWith("JETON-VALIDE"));
    expect(await screen.findByText("Supporter", { selector: "span" })).toBeInTheDocument();
    expect(await screen.findAllByText("Débloqué")).toHaveLength(3);
    expect(await screen.findByText("Licence activée.")).toBeInTheDocument();
  });

  it("Code Supporter présent : clé invalide → bannière d'erreur (valid:false)", async () => {
    vi.mocked(Api.setLicense).mockResolvedValue(ENT_INVALID);
    vi.mocked(Api.getLicense).mockResolvedValueOnce(ENT_UNLICENSED).mockResolvedValue(ENT_INVALID);
    renderWithToast(<Store />);
    await screen.findByRole("textbox");

    await userEvent.type(screen.getByRole("textbox"), "JETON-POURRI");
    await userEvent.click(screen.getByRole("button", { name: "Activer" }));

    expect(await screen.findByText(/Licence invalide.*signature invalide/)).toBeInTheDocument();
  });

  it("MAJ disponible (runtime docker) : la carte propose la commande docker", async () => {
    vi.mocked(Api.version).mockResolvedValue({
      ...demo.version,
      latest: "9.9.9",
      update_available: true,
      runtime: "docker",
    });
    renderWithToast(<Store />);
    expect(
      await screen.findByText("docker compose pull && docker compose up -d"),
    ).toBeInTheDocument();
    expect(screen.queryByText("./install.sh --update")).not.toBeInTheDocument();
  });

  it("MAJ disponible (runtime hôte) : la carte propose install.sh --update", async () => {
    vi.mocked(Api.version).mockResolvedValue({
      ...demo.version,
      latest: "9.9.9",
      update_available: true,
      runtime: "host",
    });
    renderWithToast(<Store />);
    expect(await screen.findByText("./install.sh --update")).toBeInTheDocument();
    expect(
      screen.queryByText("docker compose pull && docker compose up -d"),
    ).not.toBeInTheDocument();
  });

  it("Code Supporter présent : réinitialise la licence → retour Community", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(Api.getLicense).mockResolvedValueOnce(ENT_ACTIVE).mockResolvedValue(ENT_UNLICENSED);
    renderWithToast(<Store />);
    await screen.findByText("ACME Corp");

    await userEvent.click(screen.getByRole("button", { name: "Réinitialiser" }));

    await waitFor(() => expect(Api.deleteLicense).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Community")).toBeInTheDocument();
    expect(await screen.findByText("Licence réinitialisée.")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
