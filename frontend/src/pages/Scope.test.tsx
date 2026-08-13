import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const ENREGISTRER = "Enregistrer le périmètre et les modes";

/** `window.confirm` n'est pas implémenté par jsdom : on l'espionne, comme Automations.test.tsx. */
function confirmeAvec(reponse: boolean) {
  return vi.spyOn(window, "confirm").mockReturnValue(reponse);
}

/** Un rechargement de page est-il retenu ? `preventDefault` rend le dispatch falsy. */
function rechargementRetenu(): boolean {
  return !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
}

afterEach(() => vi.restoreAllMocks());

describe("Scope — périmètre & modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.discovery).mockImplementation((kind) =>
      Promise.resolve(kind === "entity" ? ENTITIES : CATEGORIES),
    );
    vi.mocked(Api.setScope).mockResolvedValue({ category_ids: [1], entity_ids: [0] });
    vi.mocked(Api.saveModes).mockResolvedValue([]);
    // Armer une écriture GLPI demande désormais confirmation : ces tests l'accordent.
    confirmeAvec(true);
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

/**
 * Les deux panneaux sont deux `useResource` INDÉPENDANTS : ils n'arrivent pas ensemble.
 * Un drapeau « l'admin a touché quelque chose » global à la page condamnait donc
 * l'initialisation de la liste la plus lente — le périmètre entités partait vide à un
 * `set_scope` qui REMPLACE, et le compteur imputait la perte à l'admin.
 */
describe("Scope — course d'initialisation entre les deux listes", () => {
  const ENTITES_REGLEES: RefItem[] = [
    ref({ ext_id: 0, name: "Racine", selected: true, mode: "semi_auto", auto_min_confidence: 0.8 }),
    ref({ ext_id: 1, name: "Siège", selected: false }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.setScope).mockResolvedValue({ category_ids: [], entity_ids: [0] });
    vi.mocked(Api.saveModes).mockResolvedValue([]);
    confirmeAvec(true);
  });

  it("cocher une catégorie pendant le chargement des entités n'efface pas leur périmètre", async () => {
    let livrer: (v: RefItem[]) => void = () => undefined;
    const entitesTardives = new Promise<RefItem[]>((r) => {
      livrer = r;
    });
    vi.mocked(Api.discovery).mockImplementation((kind) =>
      kind === "entity"
        ? entitesTardives
        : Promise.resolve(kind === "category" ? CATEGORIES : ([] as RefItem[])),
    );

    renderWithToast(<Scope />);
    // Les catégories sont arrivées, les entités chargent encore : c'est la fenêtre du bug.
    await screen.findByText("Compte");
    expect(screen.getByText(/0 \/ 0 sélectionnée\(s\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Compte/ }));

    await act(async () => {
      livrer(ENTITES_REGLEES);
      await entitesTardives;
    });

    // Le panneau des entités s'initialise QUAND MÊME : périmètre, mode et seuil serveur.
    await waitFor(() => expect(screen.getByText(/1 \/ 2 sélectionnée\(s\)/)).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "Mode pour Racine" })).toHaveValue("semi_auto");
    expect(screen.getByRole("spinbutton", { name: "Seuil semi-auto pour Racine" })).toHaveValue(
      0.8,
    );
    // Une seule modification en attente : la catégorie décochée. Pas deux entités « perdues ».
    expect(screen.getByText("1 modification(s) non enregistrée(s)")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: ENREGISTRER }));
    await waitFor(() => expect(Api.setScope).toHaveBeenCalledTimes(1));
    // Le cœur du défaut : `entity_ids` ne doit PAS repartir vide vers un set_scope qui remplace.
    expect(Api.setScope).toHaveBeenCalledWith({ category_ids: [], entity_ids: [0] });
    expect(vi.mocked(Api.saveModes).mock.calls[0][0][0]).toMatchObject({
      ext_id: 0,
      mode: "semi_auto",
      auto_min_confidence: 0.8,
    });
  });
});

describe("Scope — barre d'enregistrement, confirmation et garde de sortie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.discovery).mockImplementation((kind) =>
      Promise.resolve(
        kind === "entity" ? ENTITIES : kind === "category" ? CATEGORIES : ([] as RefItem[]),
      ),
    );
    vi.mocked(Api.setScope).mockResolvedValue({ category_ids: [1], entity_ids: [0] });
    vi.mocked(Api.saveModes).mockResolvedValue([]);
  });

  it("le bouton reste inerte tant que rien n'est modifié, puis le compteur dit combien", async () => {
    renderWithToast(<Scope />);
    // On attend l'ENTITÉ, pas une catégorie : les deux listes viennent de deux ressources
    // distinctes, et attendre la première pour cliquer sur la seconde était une course —
    // verte à vide, rouge dès que la machine est chargée.
    const siege = await screen.findByRole("checkbox", { name: /Siège/ });
    const bouton = screen.getByRole("button", { name: ENREGISTRER });
    expect(bouton).toBeDisabled();
    expect(screen.getByText("Aucune modification en attente")).toBeInTheDocument();

    await userEvent.click(siege);
    expect(bouton).toBeEnabled();
    expect(screen.getByText("1 modification(s) non enregistrée(s)")).toBeInTheDocument();
  });

  it("une liste qui arrive en retard n'arme jamais « Enregistrer » toute seule", async () => {
    // Le compteur est une DIFFÉRENCE entre l'écran et le serveur. Comparé à `categories.data`
    // dès son arrivée, il existait un rendu — celui d'avant l'effet d'initialisation — où le
    // serveur annonçait une catégorie cochée et où l'écran n'en portait aucune : la barre
    // disait « 1 modification(s) non enregistrée(s) » et « Enregistrer » s'armait sur une page
    // que personne n'avait touchée. Une frappe de trop et le clic partait.
    let livreCats!: (v: RefItem[]) => void;
    vi.mocked(Api.discovery).mockImplementation((kind) =>
      kind === "category"
        ? new Promise<RefItem[]>((r) => {
            livreCats = r;
          })
        : Promise.resolve(ENTITIES),
    );
    renderWithToast(<Scope />);
    const bouton = await screen.findByRole("button", { name: ENREGISTRER });
    expect(bouton).toBeDisabled();

    // Les callbacks d'un MutationObserver sont des microtâches : elles s'exécutent APRÈS le
    // commit du rendu et AVANT les effets passifs de React. C'est exactement la fenêtre où le
    // bouton s'armait, et le seul moyen de la constater depuis un test.
    const arme: boolean[] = [];
    const observateur = new MutationObserver(() =>
      arme.push(!(bouton as HTMLButtonElement).disabled),
    );
    observateur.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    await act(async () => livreCats(CATEGORIES));
    observateur.disconnect();

    expect(await screen.findByRole("checkbox", { name: /Compte/ })).toBeChecked();
    expect(arme).not.toContain(true);
    expect(bouton).toBeDisabled();
    expect(screen.getByText("Aucune modification en attente")).toBeInTheDocument();
  });

  it("ANNULER la confirmation n'arme aucune écriture GLPI", async () => {
    // Le garde-fou d'EngineSettings se contournait en changeant d'écran : ici, un `<select>`
    // puis « Enregistrer » armait la même écriture sans un mot.
    const confirm = confirmeAvec(false);
    renderWithToast(<Scope />);
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Mode pour Racine" }),
      "full_auto",
    );
    await userEvent.click(screen.getByRole("button", { name: ENREGISTRER }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(Api.setScope).not.toHaveBeenCalled();
    expect(Api.saveModes).not.toHaveBeenCalled();
  });

  it("la confirmation NOMME les entités concernées et la conséquence exacte", async () => {
    const confirm = confirmeAvec(false);
    renderWithToast(<Scope />);
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Mode pour Racine" }),
      "semi_auto",
    );
    await userEvent.click(screen.getByRole("button", { name: ENREGISTRER }));

    const message = confirm.mock.calls[0][0] as string;
    expect(message).toContain("Racine");
    expect(message).not.toContain("Siège");
    expect(message).toContain("catégorie, priorité, assignation");
  });

  it("ne demande RIEN pour une modification qui n'arme aucune écriture", async () => {
    const confirm = confirmeAvec(true);
    renderWithToast(<Scope />);
    await screen.findByText("Siège");
    await userEvent.click(screen.getByRole("checkbox", { name: /Siège/ }));
    await userEvent.click(screen.getByRole("button", { name: ENREGISTRER }));

    await waitFor(() => expect(Api.setScope).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("retient un rechargement qui emporterait les modifications non enregistrées", async () => {
    renderWithToast(<Scope />);
    // On attend l'état STABILISÉ : tant que les deux listes n'ont pas fusionné, le compteur
    // passe transitoirement par une valeur non nulle.
    await screen.findByText("Aucune modification en attente");
    // Rien à perdre : la page ne s'oppose pas au rechargement.
    expect(rechargementRetenu()).toBe(false);

    await userEvent.click(screen.getByRole("checkbox", { name: /Siège/ }));
    expect(rechargementRetenu()).toBe(true);
  });
});
