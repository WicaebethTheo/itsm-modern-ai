import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type RefItem } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { Technicians } from "./Technicians";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, discovery: vi.fn(), saveTechnicians: vi.fn(), skillCatalog: vi.fn() } };
});

const ref = (over: Partial<RefItem> & { ext_id: number; name: string }): RefItem => ({
  profile: "Technician",
  selected: false,
  eligible: false,
  skills: "",
  skill_tags: [],
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
    // `clearAllMocks` efface les implémentations : sans ce défaut, le composant appelle
    // `.then` sur `undefined` au montage. Catalogue vide = l'ancien comportement (prose seule).
    vi.mocked(Api.skillCatalog).mockResolvedValue([]);
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
        { ext_id: 11, eligible: true, skills: "AD, comptes", skill_tags: [] },
        { ext_id: 12, eligible: false, skills: "", skill_tags: [] },
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

describe("Domaines de compétence cochables", () => {
  const CATALOGUE = [
    { key: "workstation", label_fr: "Poste de travail", label_en: "Workstation", hint_fr: "PC, portables" },
    { key: "network", label_fr: "Réseau & Wifi", label_en: "Network & Wi-Fi", hint_fr: "connectivité, Wifi" },
  ];

  beforeEach(() => {
    vi.mocked(Api.skillCatalog).mockResolvedValue(CATALOGUE);
    vi.mocked(Api.saveTechnicians).mockResolvedValue([]);
  });

  it("n'affiche les domaines que pour un technicien éligible", async () => {
    vi.mocked(Api.discovery).mockResolvedValue([
      ref({ ext_id: 11, name: "Alice", eligible: false }),
    ]);
    renderWithToast(<Technicians />);
    await screen.findByText("Alice");
    // Non éligible → pas de domaines : ils ne servent qu'au routage vers un acteur autorisé.
    expect(screen.queryByRole("button", { name: "Poste de travail" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: /Alice/ }));
    expect(await screen.findByRole("button", { name: "Poste de travail" })).toBeInTheDocument();
  });

  it("envoie les domaines cochés au serveur", async () => {
    vi.mocked(Api.discovery).mockResolvedValue([
      ref({ ext_id: 11, name: "Alice", eligible: true }),
    ]);
    renderWithToast(<Technicians />);
    await userEvent.click(await screen.findByRole("button", { name: "Réseau & Wifi" }));
    await userEvent.click(screen.getByRole("button", { name: /Enregistrer/i }));

    await waitFor(() => expect(Api.saveTechnicians).toHaveBeenCalledTimes(1));
    expect(Api.saveTechnicians).toHaveBeenCalledWith([
      expect.objectContaining({ ext_id: 11, skill_tags: ["network"] }),
    ]);
  });

  it("restitue une sélection déjà enregistrée et permet de la retirer", async () => {
    vi.mocked(Api.discovery).mockResolvedValue([
      ref({ ext_id: 11, name: "Alice", eligible: true, skill_tags: ["network"] }),
    ]);
    renderWithToast(<Technicians />);
    const puce = await screen.findByRole("button", { name: "Réseau & Wifi" });
    expect(puce).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(puce);
    await userEvent.click(screen.getByRole("button", { name: /Enregistrer/i }));
    await waitFor(() => expect(Api.saveTechnicians).toHaveBeenCalled());
    expect(Api.saveTechnicians).toHaveBeenCalledWith([
      expect.objectContaining({ ext_id: 11, skill_tags: [] }),
    ]);
  });

  it("reste utilisable si le catalogue est indisponible", async () => {
    // La prose libre ne doit jamais devenir inaccessible parce qu'une liste d'aide a échoué.
    vi.mocked(Api.skillCatalog).mockRejectedValue(new Error("boom"));
    vi.mocked(Api.discovery).mockResolvedValue([
      ref({ ext_id: 11, name: "Alice", eligible: true }),
    ]);
    renderWithToast(<Technicians />);
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Poste de travail" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Précisions libres/)).toBeInTheDocument();
  });
});
