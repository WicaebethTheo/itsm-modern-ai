import { Api } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EngineSettings } from "./EngineSettings";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, getConfig: vi.fn(), updateConfig: vi.fn() },
  };
});

describe("EngineSettings — masquage PII", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Config chargée : tous les masques ON (défaut sûr).
    vi.mocked(Api.getConfig).mockResolvedValue({
      ...demo.config,
      mask_email: "true",
      mask_phone: "true",
      mask_iban: "true",
      mask_secret: "true",
    });
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
  });

  it("reflète l'état initial des masques (toggles cochés)", async () => {
    renderWithToast(<EngineSettings />);
    const email = await screen.findByRole("switch", { name: "Masquer les e-mails" });
    expect(email).toHaveAttribute("aria-checked", "true");
  });

  it("désactiver un motif et enregistrer envoie mask_email=false", async () => {
    renderWithToast(<EngineSettings />);
    const email = await screen.findByRole("switch", { name: "Masquer les e-mails" });
    await userEvent.click(email); // ON → OFF
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Api.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mask_email: false,
        mask_phone: true,
        mask_iban: true,
        mask_secret: true,
      }),
    );
  });

  it("affiche un message de confirmation après enregistrement", async () => {
    renderWithToast(<EngineSettings />);
    await screen.findByRole("switch", { name: "Masquer les e-mails" });
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(await screen.findByText("Réglages enregistrés.")).toBeInTheDocument();
  });
});
