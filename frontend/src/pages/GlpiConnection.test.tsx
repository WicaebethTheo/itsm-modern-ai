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
    Api: { ...actual.Api, getConfig: vi.fn(), health: vi.fn(), updateConfig: vi.fn() },
  };
});

describe("GlpiConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.health).mockResolvedValue(demo.health);
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
  });

  it("enregistre la connexion (updateConfig + confirmation)", async () => {
    renderWithToast(<GlpiConnection />);
    await screen.findByText("Paramètres de connexion");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Api.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ glpi_verify_tls: true, glpi_followup_legacy_9x: false }),
    );
    expect(await screen.findByText("Connexion GLPI enregistrée.")).toBeInTheDocument();
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
    expect(await screen.findByText(/GLPI injoignable/)).toBeInTheDocument();
  });
});
