import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type RefItem } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { Technicians } from "./Technicians";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      discovery: vi.fn(),
      saveTechnicians: vi.fn(),
      skillCatalog: vi.fn(),
      skillCoverage: vi.fn(),
      absences: vi.fn(),
      saveAbsences: vi.fn(),
    },
  };
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
    vi.mocked(Api.skillCoverage).mockResolvedValue([]);
    vi.mocked(Api.absences).mockResolvedValue([]);
  });

  it("liste les techniciens scannés", async () => {
    vi.mocked(Api.discovery).mockResolvedValue(TECHS);
    renderWithToast(<Technicians />);
    expect(await screen.findByText("Sylvain Martin")).toBeInTheDocument();
    expect(screen.getByText("Nadia Bouaziz")).toBeInTheDocument();
  });

  it("n'enregistre que ce qui a changé — bouton inerte tant que rien ne l'est", async () => {
    // Le bouton est DÉSACTIVÉ à l'arrivée : un enregistrement sans modification n'a pas de
    // sens, et un bouton toujours actif ne dit RIEN de ce qui reste à enregistrer. C'est le
    // compteur qui porte l'information, dans une barre collante qu'on ne peut plus rater.
    vi.mocked(Api.discovery).mockResolvedValue(TECHS);
    renderWithToast(<Technicians />);
    await screen.findByText("Sylvain Martin");

    const bouton = screen.getByRole("button", { name: "Enregistrer la sélection" });
    expect(bouton).toBeDisabled();
    expect(screen.getByText("Aucune modification en attente")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: /Nadia Bouaziz/ }));
    expect(screen.getByText("1 modification(s) non enregistrée(s)")).toBeInTheDocument();
    await userEvent.click(bouton);

    await waitFor(() => expect(Api.saveTechnicians).toHaveBeenCalledTimes(1));
    expect(Api.saveTechnicians).toHaveBeenCalledWith(
      expect.arrayContaining([
        { ext_id: 11, eligible: true, skills: "AD, comptes", skill_tags: [] },
        { ext_id: 12, eligible: true, skills: "", skill_tags: [] },
      ]),
    );
    expect(await screen.findByText("Enregistré.")).toBeInTheDocument();
  });

  it("affiche l'état vide quand rien n'a été scanné", async () => {
    vi.mocked(Api.discovery).mockResolvedValue([]);
    renderWithToast(<Technicians />);
    expect(await screen.findByText("Aucun élément")).toBeInTheDocument();
  });

  it("ne fait pas passer une lecture en ÉCHEC pour une instance jamais scannée", async () => {
    // Le bug d'origine : /api/discovery en 500 affichait « cliquez sur Scanner GLPI »,
    // l'admin scannait, ça échouait encore, et rien ne nommait jamais la cause.
    vi.mocked(Api.discovery).mockRejectedValue(new Error("HTTP 500"));
    renderWithToast(<Technicians />);
    expect(await screen.findByText(/Impossible de lire les référentiels/)).toBeInTheDocument();
    expect(screen.getByText("Liste indisponible")).toBeInTheDocument();
    expect(screen.queryByText("Aucun élément")).not.toBeInTheDocument();
  });

  it("alerte quand PERSONNE n'est éligible — l'état le plus grave de la page", async () => {
    // Sans acteur éligible, `whitelist.check` renvoie NO_ELIGIBLE_ASSIGNEE : 100 % des
    // tickets partent « à trier ». Le diagnostic se taisait exactement dans ce cas-là.
    vi.mocked(Api.discovery).mockResolvedValue([ref({ ext_id: 11, name: "Alice" })]);
    renderWithToast(<Technicians />);
    expect(await screen.findByText("Aucun technicien éligible")).toBeInTheDocument();
  });

  it("le cochage en masse ne porte QUE sur les lignes affichées", async () => {
    // Le piège : filtrer « Sylvain », cliquer le bouton, et rendre éligible toute
    // l'instance. Le libellé porte le nombre d'affichés, et l'action s'y limite.
    vi.mocked(Api.discovery).mockResolvedValue([
      ...TECHS,
      ref({ ext_id: 13, name: "Karim Haddad", eligible: false }),
    ]);
    renderWithToast(<Technicians />);
    await screen.findByText("Karim Haddad");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Rechercher un technicien" }),
      "Nadia",
    );

    await userEvent.click(await screen.findByRole("button", { name: /Cocher les 1 affichés/ }));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer la sélection" }));

    await waitFor(() => expect(Api.saveTechnicians).toHaveBeenCalledTimes(1));
    const envoyes = vi.mocked(Api.saveTechnicians).mock.calls[0][0];
    expect(envoyes.find((x) => x.ext_id === 12)?.eligible).toBe(true);
    // Karim, masqué par le filtre, garde son état : il n'a pas été balayé au passage.
    expect(envoyes.find((x) => x.ext_id === 13)?.eligible).toBe(false);
  });
});

describe("Congés vus depuis la ligne du technicien", () => {
  const absence = {
    id: 1,
    technician_ext_id: 11,
    start_date: "2026-08-01",
    end_date: "2026-08-22",
    replacement_ext_id: 12,
    note: "",
    technician_name: "Sylvain Martin",
    replacement_name: "Nadia Bouaziz",
    active: true,
  };

  beforeEach(() => {
    vi.mocked(Api.skillCatalog).mockResolvedValue([]);
    vi.mocked(Api.skillCoverage).mockResolvedValue([]);
    vi.mocked(Api.saveTechnicians).mockResolvedValue([]);
    vi.mocked(Api.discovery).mockResolvedValue(TECHS);
  });

  it("porte l'état d'absence sur la ligne de la personne concernée", async () => {
    // Une absence est un attribut d'une PERSONNE : elle se lit sur sa ligne, pas dans une
    // table qu'il faudrait aller chercher plus bas.
    vi.mocked(Api.absences).mockResolvedValue([absence]);
    renderWithToast(<Technicians />);
    expect(await screen.findByText(/Absent jusqu'au 22 août/)).toBeInTheDocument();
    expect(screen.getByText(/remplacé par Nadia Bouaziz/)).toBeInTheDocument();
  });

  it("n'offre le bouton congés qu'aux techniciens éligibles", async () => {
    vi.mocked(Api.absences).mockResolvedValue([]);
    renderWithToast(<Technicians />);
    expect(
      await screen.findByRole("button", { name: "Déclarer une absence pour Sylvain Martin" }),
    ).toBeInTheDocument();
    // Nadia n'est pas éligible : elle n'est pas dans le pool, il n'y a rien à en retirer.
    expect(
      screen.queryByRole("button", { name: "Déclarer une absence pour Nadia Bouaziz" }),
    ).not.toBeInTheDocument();
  });

  it("le bouton de la ligne ouvre la planification déjà remplie à ce nom", async () => {
    vi.mocked(Api.absences).mockResolvedValue([]);
    renderWithToast(<Technicians />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Déclarer une absence pour Sylvain Martin" }),
    );
    const select = await screen.findByRole("combobox", { name: "Technicien absent" });
    expect((select as HTMLSelectElement).value).toBe("11");
  });
});

describe("Domaines de compétence cochables", () => {
  const CATALOGUE = [
    {
      key: "workstation",
      label_fr: "Poste de travail",
      label_en: "Workstation",
      hint_fr: "PC, portables",
    },
    {
      key: "network",
      label_fr: "Réseau & Wifi",
      label_en: "Network & Wi-Fi",
      hint_fr: "connectivité, Wifi",
    },
  ];

  beforeEach(() => {
    // `clearAllMocks` indispensable ici : sans lui, l'HISTORIQUE d'appels des blocs
    // précédents fuit, et `toHaveBeenCalledTimes(1)` compte les enregistrements des autres
    // tests. Le bloc n'en avait pas et ne passait que parce que aucun test amont
    // n'appelait `saveTechnicians` avec succès.
    vi.clearAllMocks();
    vi.mocked(Api.skillCatalog).mockResolvedValue(CATALOGUE);
    vi.mocked(Api.skillCoverage).mockResolvedValue([]);
    vi.mocked(Api.absences).mockResolvedValue([]);
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
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer la sélection" }));

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
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer la sélection" }));
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

describe("Carte de couverture des domaines", () => {
  const CATALOGUE = [
    { key: "workstation", label_fr: "Poste de travail", label_en: "Workstation", hint_fr: "PC" },
    { key: "network", label_fr: "Réseau & Wifi", label_en: "Network & Wi-Fi", hint_fr: "Wifi" },
  ];
  const couverture = (over: Partial<Record<string, [number, number]>> = {}) =>
    CATALOGUE.map((d) => {
      const [technicians, groups] = over[d.key] ?? [0, 0];
      return { ...d, technicians, groups };
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.skillCatalog).mockResolvedValue(CATALOGUE);
    vi.mocked(Api.saveTechnicians).mockResolvedValue([]);
  });

  it("nomme les domaines que personne ne couvre", async () => {
    vi.mocked(Api.skillCoverage).mockResolvedValue(couverture({ workstation: [2, 0] }));
    vi.mocked(Api.discovery).mockResolvedValue([
      ref({ ext_id: 11, name: "Alice", eligible: true, skill_tags: ["workstation"] }),
      ref({ ext_id: 12, name: "Bob", eligible: true, skill_tags: ["workstation"] }),
    ]);
    renderWithToast(<Technicians />);

    const alerte = await screen.findByText(/Aucun acteur sur 1 domaine/);
    expect(alerte.parentElement?.textContent).toContain("Réseau & Wifi");
    expect(alerte.parentElement?.textContent).toContain("à trier");
  });

  it("réagit à la case cochée AVANT tout enregistrement", async () => {
    // Le serveur annonce 9 techniciens sur « Réseau » : c'est le BROUILLON qui fait foi
    // pour le type édité, sinon le bandeau contredirait ce que l'admin voit à l'écran.
    vi.mocked(Api.skillCoverage).mockResolvedValue(
      couverture({ workstation: [2, 0], network: [9, 0] }),
    );
    vi.mocked(Api.discovery).mockResolvedValue([
      ref({ ext_id: 11, name: "Alice", eligible: true, skill_tags: ["workstation"] }),
      ref({ ext_id: 12, name: "Bob", eligible: true, skill_tags: ["workstation"] }),
    ]);
    renderWithToast(<Technicians />);
    await screen.findByText(/Aucun acteur sur 1 domaine/);

    // On coche « Réseau & Wifi » sur Alice : le trou se referme immédiatement, et cède la
    // place à l'alerte de point de défaillance unique (1 technicien, aucun groupe).
    await userEvent.click(screen.getAllByRole("button", { name: "Réseau & Wifi" })[0]);
    expect(await screen.findByText(/Une seule personne sur 1 domaine/)).toBeInTheDocument();
    expect(screen.queryByText(/Aucun acteur/)).not.toBeInTheDocument();
    expect(Api.saveTechnicians).not.toHaveBeenCalled(); // aucun enregistrement requis
  });

  it("un groupe éligible lève l'alerte de point de défaillance unique", async () => {
    // Un groupe encaisse une absence sans configuration : 1 technicien + 1 groupe n'est
    // pas un point de défaillance unique, contrairement à 1 technicien seul.
    vi.mocked(Api.skillCoverage).mockResolvedValue(
      couverture({ workstation: [1, 1], network: [0, 1] }),
    );
    vi.mocked(Api.discovery).mockResolvedValue([
      ref({ ext_id: 11, name: "Alice", eligible: true, skill_tags: ["workstation", "network"] }),
    ]);
    renderWithToast(<Technicians />);

    expect(await screen.findByText(/Les 2 domaines sont couverts/)).toBeInTheDocument();
    expect(screen.queryByText(/Une seule personne/)).not.toBeInTheDocument();
  });

  it("ne s'affiche pas tant qu'aucun acteur n'est éligible", async () => {
    // Sur une instance qu'on vient de scanner, « 14 domaines non couverts » est du bruit.
    vi.mocked(Api.skillCoverage).mockResolvedValue(couverture());
    vi.mocked(Api.absences).mockResolvedValue([]);
    vi.mocked(Api.discovery).mockResolvedValue([ref({ ext_id: 11, name: "Alice" })]);
    renderWithToast(<Technicians />);

    await screen.findByText("Alice");
    expect(screen.queryByText(/Aucun acteur sur/)).not.toBeInTheDocument();
  });

  it("reste silencieuse si le diagnostic est indisponible", async () => {
    // On n'ampute pas la page de configuration parce qu'un diagnostic n'a pas pu charger.
    vi.mocked(Api.skillCoverage).mockRejectedValue(new Error("boom"));
    vi.mocked(Api.discovery).mockResolvedValue([
      ref({ ext_id: 11, name: "Alice", eligible: true }),
    ]);
    renderWithToast(<Technicians />);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText(/Aucun acteur sur/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enregistrer la sélection" })).toBeInTheDocument();
  });
});
