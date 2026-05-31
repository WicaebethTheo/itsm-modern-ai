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

// Image ENTERPRISE, non licenciée : le code est installé (installed:true) mais aucune
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

// Image ENTERPRISE, licence valide → tout actif.
const ENT_ACTIVE: LicenseView = {
  edition: "enterprise",
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

// Image ENTERPRISE, clé refusée (valid:false) → bannière d'erreur, activation visible.
const ENT_INVALID: LicenseView = { ...ENT_UNLICENSED, valid: false, error: "signature invalide" };

describe("Store (licence open-core)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.setLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.deleteLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.version).mockResolvedValue(demo.version);
  });

  it("Community : pas de champ d'activation, encart d'upgrade + features verrouillées", async () => {
    renderWithToast(<Store />);
    expect(await screen.findByText("Community")).toBeInTheDocument();
    // Aucune feature installée (image Community) → pas d'activation par clé.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activer" })).not.toBeInTheDocument();
    // À la place : l'encart d'upgrade.
    expect(screen.getByText("Passer en édition Enterprise")).toBeInTheDocument();
    // Les 3 features, toutes verrouillées.
    expect(screen.getAllByText("Enterprise")).toHaveLength(3);
    expect(screen.queryByText("Débloqué")).not.toBeInTheDocument();
  });

  it("Image Enterprise : active une clé valide → édition Enterprise + features débloquées", async () => {
    vi.mocked(Api.setLicense).mockResolvedValue(ENT_ACTIVE);
    vi.mocked(Api.getLicense).mockResolvedValueOnce(ENT_UNLICENSED).mockResolvedValue(ENT_ACTIVE);
    renderWithToast(<Store />);
    // Sur l'image Enterprise non licenciée, le champ d'activation est présent.
    await screen.findByRole("textbox");

    await userEvent.type(screen.getByRole("textbox"), "JETON-VALIDE");
    await userEvent.click(screen.getByRole("button", { name: "Activer" }));

    await waitFor(() => expect(Api.setLicense).toHaveBeenCalledWith("JETON-VALIDE"));
    expect(await screen.findByText("Enterprise", { selector: "span" })).toBeInTheDocument();
    expect(await screen.findAllByText("Débloqué")).toHaveLength(3);
    expect(await screen.findByText("Licence activée.")).toBeInTheDocument();
  });

  it("Image Enterprise : clé invalide → bannière d'erreur (valid:false)", async () => {
    vi.mocked(Api.setLicense).mockResolvedValue(ENT_INVALID);
    vi.mocked(Api.getLicense).mockResolvedValueOnce(ENT_UNLICENSED).mockResolvedValue(ENT_INVALID);
    renderWithToast(<Store />);
    await screen.findByRole("textbox");

    await userEvent.type(screen.getByRole("textbox"), "JETON-POURRI");
    await userEvent.click(screen.getByRole("button", { name: "Activer" }));

    expect(await screen.findByText(/Licence invalide.*signature invalide/)).toBeInTheDocument();
  });

  it("Image Enterprise : réinitialise la licence → retour Community", async () => {
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
