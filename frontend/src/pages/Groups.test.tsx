import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type RefItem } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { Groups } from "./Groups";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      discovery: vi.fn(),
      saveGroups: vi.fn(),
      skillCatalog: vi.fn(),
      skillCoverage: vi.fn(),
    },
  };
});

const ref = (over: Partial<RefItem> & { ext_id: number; name: string }): RefItem => ({
  profile: "",
  selected: false,
  eligible: false,
  skills: "",
  skill_tags: [],
  mode: null,
  ...over,
});

const GROUPES: RefItem[] = [
  ref({ ext_id: 5, name: "Support N1", eligible: true, skills: "premier niveau" }),
  ref({ ext_id: 6, name: "Support N2" }),
];

const CATALOGUE = [
  { key: "workstation", label_fr: "Poste de travail", label_en: "Workstation", hint_fr: "PC" },
];

/**
 * La page Groupes n'avait AUCUN test alors qu'elle partage tout son code avec Techniciens :
 * rien ne protégeait ce qui lui est propre — sa sémantique de CIBLE DE REPLI, et les textes
 * qui parlaient encore du « technicien » parce que l'éditeur est mutualisé.
 */
describe("Groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.discovery).mockResolvedValue(GROUPES);
    vi.mocked(Api.saveGroups).mockResolvedValue([]);
    vi.mocked(Api.skillCatalog).mockResolvedValue(CATALOGUE);
    vi.mocked(Api.skillCoverage).mockResolvedValue([]);
  });

  it("se présente comme des CIBLES DE REPLI, pas comme des exécutants", async () => {
    // Un groupe encaisse une absence sans configuration : c'est ce qui justifie qu'on le
    // préfère à une personne nommée comme filet de sécurité (cf. `fallback_group_id`).
    renderWithToast(<Groups />);
    expect(await screen.findByText(/Cibles de repli/)).toBeInTheDocument();
    expect(screen.getByText("Support N1")).toBeInTheDocument();
    expect(screen.getByText("Support N2")).toBeInTheDocument();
  });

  it("ne parle plus de « ce technicien » sur une page de groupes", async () => {
    renderWithToast(<Groups />);
    expect(await screen.findByText(/cochez pour décrire ce groupe/)).toBeInTheDocument();
    expect(screen.queryByText(/décrire ce technicien/)).not.toBeInTheDocument();
  });

  it("ne propose plus d'y noter des « disponibilités » — les congés ont leur outil", async () => {
    renderWithToast(<Groups />);
    const zone = await screen.findByPlaceholderText(/Précisions libres/);
    expect(zone.getAttribute("placeholder")).toContain("exclusions");
    expect(zone.getAttribute("placeholder")).not.toContain("disponibilités");
  });

  it("enregistre l'éligibilité via saveGroups, et pas avant qu'on ait touché à quelque chose", async () => {
    renderWithToast(<Groups />);
    await screen.findByText("Support N2");
    const bouton = screen.getByRole("button", { name: "Enregistrer la sélection" });
    expect(bouton).toBeDisabled();

    await userEvent.click(screen.getByRole("checkbox", { name: /Support N2/ }));
    await userEvent.click(bouton);

    await waitFor(() => expect(Api.saveGroups).toHaveBeenCalledTimes(1));
    expect(Api.saveGroups).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ ext_id: 6, eligible: true })]),
    );
    expect(await screen.findByText("Enregistré.")).toBeInTheDocument();
  });

  it("n'envoie QUE les fiches modifiées — Support N1 n'est pas réécrit au passage", async () => {
    // `set_eligibility` écrit par `ext_id` : renvoyer une ligne inchangée écrase la version
    // d'un autre onglet par celle qu'on avait lue avant lui.
    renderWithToast(<Groups />);
    await screen.findByText("Support N2");
    await userEvent.click(screen.getByRole("checkbox", { name: /Support N2/ }));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer la sélection" }));

    await waitFor(() => expect(Api.saveGroups).toHaveBeenCalledTimes(1));
    expect(vi.mocked(Api.saveGroups).mock.calls[0][0]).toEqual([
      { ext_id: 6, eligible: true, skills: "", skill_tags: [] },
    ]);
  });

  it("retient un rechargement qui emporterait les modifications non enregistrées", async () => {
    // Le compteur promettait « N modifications non enregistrées » et un F5 les emportait
    // sans un mot. (Le blocage du menu latéral exigerait un data router : cf. App.tsx.)
    const recharge = () => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    renderWithToast(<Groups />);
    await screen.findByText("Aucune modification en attente");
    expect(recharge()).toBe(false);

    await userEvent.click(screen.getByRole("checkbox", { name: /Support N2/ }));
    expect(recharge()).toBe(true);
  });

  it("avertit quand aucun groupe n'est éligible : plus aucun filet de repli", async () => {
    vi.mocked(Api.discovery).mockResolvedValue([ref({ ext_id: 5, name: "Support N1" })]);
    renderWithToast(<Groups />);
    expect(await screen.findByText("Aucun groupe éligible")).toBeInTheDocument();
  });

  it("distingue une lecture en échec d'une instance jamais scannée", async () => {
    vi.mocked(Api.discovery).mockRejectedValue(new Error("HTTP 500"));
    renderWithToast(<Groups />);
    expect(await screen.findByText(/Impossible de lire les référentiels/)).toBeInTheDocument();
    expect(screen.queryByText("Aucun élément")).not.toBeInTheDocument();
  });

  it("affiche l'état vide quand rien n'a été scanné", async () => {
    vi.mocked(Api.discovery).mockResolvedValue([]);
    renderWithToast(<Groups />);
    expect(await screen.findByText("Aucun élément")).toBeInTheDocument();
  });
});
