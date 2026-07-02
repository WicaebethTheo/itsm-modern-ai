import { Api } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlpiConnection } from "./GlpiConnection";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      getConfig: vi.fn(),
      health: vi.fn(),
      updateConfig: vi.fn(),
      glpiWhoami: vi.fn(),
      resetGlpi: vi.fn(),
    },
  };
});

describe("GlpiConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.health).mockResolvedValue(demo.health);
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.glpiWhoami).mockResolvedValue(demo.glpiAccount);
    vi.mocked(Api.resetGlpi).mockResolvedValue({ ok: true });
  });

  it("affiche le compte utilisé par le bot (aperçu live)", async () => {
    renderWithToast(<GlpiConnection />);
    await screen.findByText("Compte utilisé par le bot");
    // Nom en gras dans la carte.
    expect(await screen.findByText("Bot Triage IT")).toBeInTheDocument();
    // Ligne secondaire : rôle · @login.
    expect(screen.getByText(/Technician.*@svc_triage/)).toBeInTheDocument();
  });

  it("enregistre la connexion (updateConfig + confirmation)", async () => {
    renderWithToast(<GlpiConnection />);
    await screen.findByText("Paramètres de connexion");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Api.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        glpi_verify_tls: true,
        glpi_followup_legacy_9x: false,
        glpi_api_version: "legacy",
      }),
    );
    expect(await screen.findByText("Connexion GLPI enregistrée.")).toBeInTheDocument();
  });

  it("bascule en V2 : affiche les champs OAuth et enregistre glpi_api_version=v2", async () => {
    renderWithToast(<GlpiConnection />);
    await screen.findByText("Paramètres de connexion");

    // En legacy, les champs OAuth sont absents.
    expect(screen.queryByText("Client ID")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /API V2/ }));

    expect(await screen.findByText("Client ID")).toBeInTheDocument();
    expect(screen.getByText("Identifiant (username)")).toBeInTheDocument();
    expect(screen.getByText("Client secret")).toBeInTheDocument();
    // Les tokens legacy ne sont plus affichés.
    expect(screen.queryByText("User token")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Api.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ glpi_api_version: "v2" }),
    );
  });

  it("ne renvoie pas de scope en mode legacy même après être passé par V2", async () => {
    renderWithToast(<GlpiConnection />);
    await screen.findByText("Paramètres de connexion");
    // V2 → modifier un scope (entre dans `form`) → revenir en legacy → Enregistrer.
    await userEvent.click(screen.getByRole("button", { name: /API V2/ }));
    await screen.findByText("Client ID");
    await userEvent.click(screen.getByRole("switch", { name: "email" }));
    await userEvent.click(screen.getByRole("button", { name: /Legacy/ }));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(Api.updateConfig).mock.calls[0][0];
    expect(payload.glpi_api_version).toBe("legacy");
    expect("glpi_oauth_scope" in payload).toBe(false); // pas de scope orphelin en legacy
  });

  it("le test de connexion rapporte un GLPI joignable", async () => {
    renderWithToast(<GlpiConnection />);
    await screen.findByText("Paramètres de connexion");
    await userEvent.click(screen.getByRole("button", { name: "Tester la connexion" }));
    expect(await screen.findByText("Connexion GLPI OK (joignable).")).toBeInTheDocument();
  });

  it("signale un GLPI injoignable", async () => {
    vi.mocked(Api.health).mockResolvedValue({
      ...demo.health,
      glpi: { configured: true, reachable: false },
    });
    renderWithToast(<GlpiConnection />);
    await screen.findByText("Paramètres de connexion");
    await userEvent.click(screen.getByRole("button", { name: "Tester la connexion" }));
    // Encart inline persistant sous les boutons (en plus du toast).
    expect(await screen.findByText(/GLPI injoignable — vérifier/)).toBeInTheDocument();
  });

  it("V2 : sélection multiple des scopes, enregistre une chaîne triée", async () => {
    renderWithToast(<GlpiConnection />);
    await screen.findByText("Paramètres de connexion");
    await userEvent.click(screen.getByRole("button", { name: /API V2/ }));

    // Les 6 scopes sont présentés en toggles (rôle switch).
    await screen.findByText("Scopes OAuth");
    const emailSwitch = screen.getByRole("switch", { name: "email" });
    await userEvent.click(emailSwitch);

    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    // demo.config a "api user" → + email coché → chaîne triée.
    expect(Api.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ glpi_oauth_scope: "api email user" }),
    );
  });

  it("réinitialise la connexion GLPI (confirm + resetGlpi)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithToast(<GlpiConnection />);
    await screen.findByText("Paramètres de connexion");
    await userEvent.click(screen.getByRole("button", { name: "Réinitialiser" }));

    await waitFor(() => expect(Api.resetGlpi).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Connexion GLPI réinitialisée.")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
