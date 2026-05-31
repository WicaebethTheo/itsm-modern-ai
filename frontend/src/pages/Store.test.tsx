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
    },
  };
});

// Licence Enterprise valide avec le catalogue débloqué (active:true).
const ENTERPRISE: LicenseView = {
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

const INVALID: LicenseView = {
  ...demo.license,
  valid: false,
  error: "signature invalide",
};

describe("Store (licence open-core)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.setLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.deleteLicense).mockResolvedValue(demo.license);
  });

  it("affiche l'édition Community et les 3 features verrouillées par défaut", async () => {
    renderWithToast(<Store />);
    expect(await screen.findByText("Community")).toBeInTheDocument();
    // Les 3 features du catalogue.
    expect(screen.getByText("Masquage avancé (NER)")).toBeInTheDocument();
    expect(screen.getByText("Multi-entités")).toBeInTheDocument();
    expect(screen.getByText("Exports planifiés")).toBeInTheDocument();
    // Toutes verrouillées (badge Enterprise), aucune débloquée.
    expect(screen.getAllByText("Enterprise")).toHaveLength(3);
    expect(screen.queryByText("Débloqué")).not.toBeInTheDocument();
  });

  it("active une clé valide → passe en édition Enterprise", async () => {
    vi.mocked(Api.setLicense).mockResolvedValue(ENTERPRISE);
    vi.mocked(Api.getLicense)
      .mockResolvedValueOnce(demo.license) // chargement initial
      .mockResolvedValue(ENTERPRISE); // après reload
    renderWithToast(<Store />);
    await screen.findByText("Community");

    await userEvent.type(screen.getByRole("textbox"), "JETON-VALIDE");
    await userEvent.click(screen.getByRole("button", { name: "Activer" }));

    await waitFor(() => expect(Api.setLicense).toHaveBeenCalledWith("JETON-VALIDE"));
    expect(await screen.findByText("Enterprise", { selector: "span" })).toBeInTheDocument();
    expect(await screen.findAllByText("Débloqué")).toHaveLength(3);
    expect(await screen.findByText("Licence activée.")).toBeInTheDocument();
  });

  it("affiche l'erreur d'une clé invalide (valid:false)", async () => {
    vi.mocked(Api.setLicense).mockResolvedValue(INVALID);
    vi.mocked(Api.getLicense).mockResolvedValueOnce(demo.license).mockResolvedValue(INVALID);
    renderWithToast(<Store />);
    await screen.findByText("Community");

    await userEvent.type(screen.getByRole("textbox"), "JETON-POURRI");
    await userEvent.click(screen.getByRole("button", { name: "Activer" }));

    // Encart inline persistant (en plus du toast).
    expect(await screen.findByText(/Licence invalide.*signature invalide/)).toBeInTheDocument();
  });

  it("réinitialise la licence → retour Community", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    // Démarre en Enterprise pour que le bouton Réinitialiser soit actif.
    vi.mocked(Api.getLicense).mockResolvedValueOnce(ENTERPRISE).mockResolvedValue(demo.license);
    renderWithToast(<Store />);
    await screen.findByText("ACME Corp");

    await userEvent.click(screen.getByRole("button", { name: "Réinitialiser" }));

    await waitFor(() => expect(Api.deleteLicense).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Community")).toBeInTheDocument();
    expect(await screen.findByText("Licence réinitialisée.")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
