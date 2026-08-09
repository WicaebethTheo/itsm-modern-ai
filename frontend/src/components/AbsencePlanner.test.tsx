import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AbsenceView, Api, type RefItem } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { AbsencePlanner } from "./AbsencePlanner";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, discovery: vi.fn(), absences: vi.fn(), saveAbsences: vi.fn() },
  };
});

const tech = (ext_id: number, name: string, eligible = true): RefItem => ({
  ext_id,
  name,
  profile: "",
  selected: false,
  eligible,
  skills: "",
  skill_tags: [],
  mode: null,
});

const TECHS = [tech(11, "Adrien"), tech(12, "Nadia"), tech(13, "Non éligible", false)];

const absence = (over: Partial<AbsenceView> = {}): AbsenceView => ({
  id: 1,
  technician_ext_id: 11,
  start_date: "2026-08-10",
  end_date: "2026-08-22",
  replacement_ext_id: 12,
  note: "",
  technician_name: "Adrien",
  replacement_name: "Nadia",
  active: true,
  ...over,
});

describe("AbsencePlanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.discovery).mockResolvedValue(TECHS);
    vi.mocked(Api.absences).mockResolvedValue([]);
    vi.mocked(Api.saveAbsences).mockResolvedValue([]);
  });

  it("ne propose que des techniciens éligibles", async () => {
    vi.mocked(Api.absences).mockResolvedValue([absence()]);
    renderWithToast(<AbsencePlanner />);
    const select = await screen.findByRole("combobox", { name: "Technicien absent" });
    const noms = [...select.querySelectorAll("option")].map((o) => o.textContent);
    // Un non-éligible ne peut pas être « retiré du pool » : il n'y est pas.
    expect(noms).toEqual(["Adrien", "Nadia"]);
  });

  it("signale une absence en cours", async () => {
    vi.mocked(Api.absences).mockResolvedValue([absence({ active: true })]);
    renderWithToast(<AbsencePlanner />);
    expect(await screen.findByText("En cours")).toBeInTheDocument();
  });

  it("n'offre pas quelqu'un comme son propre remplaçant", async () => {
    vi.mocked(Api.absences).mockResolvedValue([absence({ technician_ext_id: 11 })]);
    renderWithToast(<AbsencePlanner />);
    const select = await screen.findByRole("combobox", { name: "Remplaçant" });
    const noms = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(noms).toEqual(["Sans remplaçant", "Nadia"]);
  });

  it("enregistre la liste complète sans l'identifiant local", async () => {
    vi.mocked(Api.absences).mockResolvedValue([absence()]);
    renderWithToast(<AbsencePlanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Enregistrer les absences" }));

    await waitFor(() => expect(Api.saveAbsences).toHaveBeenCalledTimes(1));
    expect(vi.mocked(Api.saveAbsences).mock.calls[0][0]).toEqual([
      {
        technician_ext_id: 11,
        start_date: "2026-08-10",
        end_date: "2026-08-22",
        replacement_ext_id: 12,
        note: "",
      },
    ]);
  });

  it("remonte le refus du serveur au lieu de l'avaler", async () => {
    // Avaler l'erreur laisserait l'admin croire à un filet qui n'a jamais existé.
    vi.mocked(Api.absences).mockResolvedValue([absence()]);
    vi.mocked(Api.saveAbsences).mockRejectedValue(
      new Error("Le remplaçant #13 n'est pas éligible"),
    );
    renderWithToast(<AbsencePlanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Enregistrer les absences" }));
    expect(await screen.findByText(/n'est pas éligible/)).toBeInTheDocument();
  });

  it("prévient d'une période inversée avant même l'envoi", async () => {
    vi.mocked(Api.absences).mockResolvedValue([
      absence({ start_date: "2026-08-22", end_date: "2026-08-10" }),
    ]);
    renderWithToast(<AbsencePlanner />);
    expect(await screen.findByText(/se termine avant son début/)).toBeInTheDocument();
  });

  it("reste invisible tant qu'aucun technicien n'est éligible", async () => {
    vi.mocked(Api.discovery).mockResolvedValue([tech(13, "Non éligible", false)]);
    renderWithToast(<AbsencePlanner />);
    await waitFor(() => expect(Api.absences).toHaveBeenCalled());
    expect(screen.queryByText("Congés & remplaçants")).not.toBeInTheDocument();
  });
});
