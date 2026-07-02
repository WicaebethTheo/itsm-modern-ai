import { Api, type RefItem } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Technicians } from "./Technicians";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, discovery: vi.fn(), saveTechnicians: vi.fn() } };
});

const ref = (over: Partial<RefItem> & { ext_id: number; name: string }): RefItem => ({
  profile: "Technician",
  selected: false,
  eligible: false,
  skills: "",
  mode: null,
  ...over,
});

const TECHS: RefItem[] = [
  ref({ ext_id: 11, name: "Sylvain Martin", eligible: true, skills: "AD, comptes" }),
  ref({ ext_id: 12, name: "Nadia Bouaziz", eligible: false }),
];

describe("Technicians (éditeur d'éligibilité)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.saveTechnicians).mockResolvedValue([]);
  });

  it("liste les techniciens scannés", async () => {
    vi.mocked(Api.discovery).mockResolvedValue(TECHS);
    renderWithToast(<Technicians />);
    expect(await screen.findByText("Sylvain Martin")).toBeInTheDocument();
    expect(screen.getByText("Nadia Bouaziz")).toBeInTheDocument();
  });

  it("enregistre l'éligibilité (saveTechnicians + confirmation)", async () => {
    vi.mocked(Api.discovery).mockResolvedValue(TECHS);
    renderWithToast(<Technicians />);
    await screen.findByText("Sylvain Martin");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer la sélection" }));

    await waitFor(() => expect(Api.saveTechnicians).toHaveBeenCalledTimes(1));
    expect(Api.saveTechnicians).toHaveBeenCalledWith(
      expect.arrayContaining([
        { ext_id: 11, eligible: true, skills: "AD, comptes" },
        { ext_id: 12, eligible: false, skills: "" },
      ]),
    );
    expect(await screen.findByText("Enregistré.")).toBeInTheDocument();
  });

  it("affiche l'état vide quand rien n'a été scanné", async () => {
    vi.mocked(Api.discovery).mockResolvedValue([]);
    renderWithToast(<Technicians />);
    expect(await screen.findByText("Aucun élément")).toBeInTheDocument();
  });
});
