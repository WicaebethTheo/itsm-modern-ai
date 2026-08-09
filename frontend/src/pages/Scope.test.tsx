import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type RefItem } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { Scope } from "./Scope";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, discovery: vi.fn(), setScope: vi.fn(), saveModes: vi.fn() },
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

const CATEGORIES: RefItem[] = [ref({ ext_id: 1, name: "Compte", selected: true })];
const ENTITIES: RefItem[] = [
  ref({ ext_id: 0, name: "Racine", selected: true }),
  ref({ ext_id: 1, name: "Siège", selected: false }),
];

describe("Scope — périmètre & modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.discovery).mockImplementation((kind) =>
      Promise.resolve(kind === "entity" ? ENTITIES : CATEGORIES),
    );
    vi.mocked(Api.setScope).mockResolvedValue({ category_ids: [1], entity_ids: [0] });
    vi.mocked(Api.saveModes).mockResolvedValue([]);
  });

  it("affiche l'avertissement quand une entité passe en full-auto", async () => {
    renderWithToast(<Scope />);
    const selects = await screen.findAllByRole("combobox");
    await userEvent.selectOptions(selects[0], "full_auto");
    expect(
      screen.getByText(/modifiera réellement les champs des tickets GLPI/),
    ).toBeInTheDocument();
  });

  it("enregistre le périmètre et les modes par entité", async () => {
    renderWithToast(<Scope />);
    const selects = await screen.findAllByRole("combobox");
    await userEvent.selectOptions(selects[0], "full_auto"); // entité 0 (Racine)
    await userEvent.click(
      screen.getByRole("button", { name: "Enregistrer le périmètre et les modes" }),
    );

    await waitFor(() => expect(Api.saveModes).toHaveBeenCalledTimes(1));
    expect(Api.setScope).toHaveBeenCalledWith({ category_ids: [1], entity_ids: [0] });
    expect(Api.saveModes).toHaveBeenCalledWith([
      {
        ext_id: 0,
        mode: "full_auto",
        auto_min_confidence: null,
        fallback_group_id: null,
        fallback_technician_id: null,
      },
      {
        ext_id: 1,
        mode: null,
        auto_min_confidence: null,
        fallback_group_id: null,
        fallback_technician_id: null,
      },
    ]);
    expect(await screen.findByText("Périmètre et modes enregistrés.")).toBeInTheDocument();
  });
});

describe("Scope — cible de repli par entité", () => {
  const GROUPS: RefItem[] = [ref({ ext_id: 5, name: "Support N1", eligible: true })];
  const TECHS: RefItem[] = [
    ref({ ext_id: 11, name: "Sylvain", eligible: true }),
    ref({ ext_id: 12, name: "Non éligible", eligible: false }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.discovery).mockImplementation((kind) =>
      Promise.resolve(
        kind === "entity"
          ? ENTITIES
          : kind === "group"
            ? GROUPS
            : kind === "technician"
              ? TECHS
              : CATEGORIES,
      ),
    );
    vi.mocked(Api.setScope).mockResolvedValue({ category_ids: [1], entity_ids: [0] });
    vi.mocked(Api.saveModes).mockResolvedValue([]);
  });

  it("ne propose que des acteurs éligibles, groupes en tête", async () => {
    // Un acteur non éligible serait refusé par le backend : le proposer promettrait un
    // filet inexistant. Les groupes passent devant : un groupe encaisse une absence.
    renderWithToast(<Scope />);
    const repli = (await screen.findAllByRole("combobox", { name: /Repli pour Racine/ }))[0];
    const options = [...repli.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["Repli : aucun", "Groupe Support N1", "Sylvain"]);
  });

  it("envoie la cible choisie et n'en garde qu'une des deux", async () => {
    renderWithToast(<Scope />);
    const repli = (await screen.findAllByRole("combobox", { name: /Repli pour Racine/ }))[0];
    await userEvent.selectOptions(repli, "g:5");
    await userEvent.click(
      screen.getByRole("button", { name: "Enregistrer le périmètre et les modes" }),
    );

    await waitFor(() => expect(Api.saveModes).toHaveBeenCalledTimes(1));
    expect(vi.mocked(Api.saveModes).mock.calls[0][0][0]).toMatchObject({
      ext_id: 0,
      fallback_group_id: 5,
      fallback_technician_id: null,
    });
  });

  it("masque le repli en mode suggestion, où il resterait sans effet", async () => {
    renderWithToast(<Scope />);
    const modes = await screen.findAllByRole("combobox", { name: /Mode pour Racine/ });
    expect(screen.queryAllByRole("combobox", { name: /Repli pour Racine/ })).toHaveLength(1);
    await userEvent.selectOptions(modes[0], "suggestion");
    expect(screen.queryAllByRole("combobox", { name: /Repli pour Racine/ })).toHaveLength(0);
  });
});
