import { Api, type RefItem } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      { ext_id: 0, mode: "full_auto", auto_min_confidence: null },
      { ext_id: 1, mode: null, auto_min_confidence: null },
    ]);
    expect(await screen.findByText("Périmètre et modes enregistrés.")).toBeInTheDocument();
  });
});
