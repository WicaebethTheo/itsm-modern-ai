import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AbsenceView, Api, type RefItem, type SkillCoverage } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { AbsencePlanner, AbsenceRowStatus } from "./AbsencePlanner";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      discovery: vi.fn(),
      absences: vi.fn(),
      saveAbsences: vi.fn(),
      skillCoverage: vi.fn(),
    },
  };
});

const tech = (
  ext_id: number,
  name: string,
  eligible = true,
  skill_tags: string[] = [],
): RefItem => ({
  ext_id,
  name,
  profile: "",
  selected: false,
  eligible,
  skills: "",
  skill_tags,
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

/**
 * La table éditable est REPLIÉE par défaut : le résumé « qui est absent » est ce qu'on vient
 * lire, la table est l'outil de gestion. Les tests qui portent sur les champs l'ouvrent donc
 * d'abord — comme l'admin.
 */
async function ouvrirLaTable() {
  await userEvent.click(await screen.findByRole("button", { name: /Gérer les absences/ }));
}

describe("AbsencePlanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.discovery).mockResolvedValue(TECHS);
    vi.mocked(Api.absences).mockResolvedValue([]);
    vi.mocked(Api.saveAbsences).mockResolvedValue([]);
    vi.mocked(Api.skillCoverage).mockResolvedValue([]);
  });

  it("ne propose que des techniciens éligibles", async () => {
    vi.mocked(Api.absences).mockResolvedValue([absence()]);
    renderWithToast(<AbsencePlanner />);
    await ouvrirLaTable();
    const select = await screen.findByRole("combobox", { name: "Technicien absent" });
    const noms = [...select.querySelectorAll("option")].map((o) => o.textContent);
    // Un non-éligible ne peut pas être « retiré du pool » : il n'y est pas.
    expect(noms).toEqual(["Adrien", "Nadia"]);
  });

  it("signale une absence en cours", async () => {
    vi.mocked(Api.absences).mockResolvedValue([absence({ active: true })]);
    renderWithToast(<AbsencePlanner />);
    await ouvrirLaTable();
    expect(await screen.findByText("En cours")).toBeInTheDocument();
  });

  it("n'offre pas quelqu'un comme son propre remplaçant", async () => {
    vi.mocked(Api.absences).mockResolvedValue([absence({ technician_ext_id: 11 })]);
    renderWithToast(<AbsencePlanner />);
    await ouvrirLaTable();
    const select = await screen.findByRole("combobox", { name: "Remplaçant" });
    const noms = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(noms).toEqual(["Sans remplaçant", "Nadia"]);
  });

  it("enregistre la liste complète sans l'identifiant local", async () => {
    vi.mocked(Api.absences).mockResolvedValue([absence()]);
    renderWithToast(<AbsencePlanner />);
    await ouvrirLaTable();
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
    await ouvrirLaTable();
    await userEvent.click(await screen.findByRole("button", { name: "Enregistrer les absences" }));
    expect(await screen.findByText(/n'est pas éligible/)).toBeInTheDocument();
  });

  it("prévient d'une période inversée avant même l'envoi", async () => {
    vi.mocked(Api.absences).mockResolvedValue([
      absence({ start_date: "2026-08-22", end_date: "2026-08-10" }),
    ]);
    renderWithToast(<AbsencePlanner />);
    await ouvrirLaTable();
    expect(await screen.findByText(/se termine avant son début/)).toBeInTheDocument();
  });

  it("reste invisible tant qu'aucun technicien n'est éligible", async () => {
    vi.mocked(Api.discovery).mockResolvedValue([tech(13, "Non éligible", false)]);
    renderWithToast(<AbsencePlanner />);
    await waitFor(() => expect(Api.absences).toHaveBeenCalled());
    expect(screen.queryByText("Congés & remplaçants")).not.toBeInTheDocument();
  });
});

describe("Résumé de disponibilité", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.discovery).mockResolvedValue(TECHS);
    vi.mocked(Api.absences).mockResolvedValue([]);
    vi.mocked(Api.saveAbsences).mockResolvedValue([]);
    vi.mocked(Api.skillCoverage).mockResolvedValue([]);
  });

  it("dit qui est absent SANS ouvrir la table", async () => {
    // Le cœur du problème corrigé : l'information se lit d'un coup d'œil, sans déplier.
    vi.mocked(Api.absences).mockResolvedValue([absence()]);
    renderWithToast(<AbsencePlanner />);
    expect(await screen.findByText(/Absent\(s\) aujourd'hui/)).toBeInTheDocument();
    expect(screen.getByText("Adrien")).toBeInTheDocument();
    expect(screen.getByText(/jusqu'au 22 août/)).toBeInTheDocument();
    expect(screen.getByText("Nadia")).toBeInTheDocument(); // le remplaçant, nommé
    expect(screen.queryByRole("combobox", { name: "Technicien absent" })).not.toBeInTheDocument();
  });

  it("distingue une absence à venir d'une absence en cours", async () => {
    vi.mocked(Api.absences).mockResolvedValue([
      absence({ start_date: "2099-01-05", end_date: "2099-01-09", active: false }),
    ]);
    renderWithToast(<AbsencePlanner />);
    expect(await screen.findByText(/Toute l'équipe est disponible/)).toBeInTheDocument();
    expect(screen.getByText(/1 absence\(s\) à venir/)).toBeInTheDocument();
  });

  it("nomme le domaine qui tombe parce que la seule personne qui le tient est absente", async () => {
    // LE risque métier : Adrien est seul sur « Réseau », il part, personne ne le remplace →
    // tout ticket réseau partira « à trier ». C'est ce croisement qui donne son sens à l'écran.
    const coverage: SkillCoverage[] = [
      { key: "network", label_fr: "Réseau & Wifi", label_en: "Network", technicians: 1, groups: 0 },
    ];
    vi.mocked(Api.skillCoverage).mockResolvedValue(coverage);
    vi.mocked(Api.discovery).mockResolvedValue([
      tech(11, "Adrien", true, ["network"]),
      tech(12, "Nadia"),
    ]);
    vi.mocked(Api.absences).mockResolvedValue([absence({ replacement_ext_id: null })]);
    renderWithToast(<AbsencePlanner />);

    const alerte = await screen.findByText(/1 domaine\(s\) sans personne aujourd'hui/);
    expect(alerte.parentElement?.textContent).toContain("Réseau & Wifi");
    expect(alerte.parentElement?.textContent).toContain("à trier");
  });

  it("se tait quand le remplaçant hérite du domaine", async () => {
    // Le remplaçant hérite des domaines de l'absent (interim_context) : rien ne tombe.
    vi.mocked(Api.skillCoverage).mockResolvedValue([
      { key: "network", label_fr: "Réseau & Wifi", label_en: "Network", technicians: 1, groups: 0 },
    ]);
    vi.mocked(Api.discovery).mockResolvedValue([
      tech(11, "Adrien", true, ["network"]),
      tech(12, "Nadia"),
    ]);
    vi.mocked(Api.absences).mockResolvedValue([absence({ replacement_ext_id: 12 })]);
    renderWithToast(<AbsencePlanner />);

    await screen.findByText(/Absent\(s\) aujourd'hui/);
    expect(screen.queryByText(/sans personne aujourd'hui/)).not.toBeInTheDocument();
  });

  it("se tait quand un groupe éligible couvre le domaine", async () => {
    // Un groupe encaisse l'absence sans configuration : ce n'est pas une panne.
    vi.mocked(Api.skillCoverage).mockResolvedValue([
      { key: "network", label_fr: "Réseau & Wifi", label_en: "Network", technicians: 1, groups: 1 },
    ]);
    vi.mocked(Api.discovery).mockResolvedValue([tech(11, "Adrien", true, ["network"])]);
    vi.mocked(Api.absences).mockResolvedValue([absence({ replacement_ext_id: null })]);
    renderWithToast(<AbsencePlanner />);

    await screen.findByText(/Absent\(s\) aujourd'hui/);
    expect(screen.queryByText(/sans personne aujourd'hui/)).not.toBeInTheDocument();
  });

  it("ouvre la table sur la ligne du technicien demandé", async () => {
    // Demande venue de la LIGNE du technicien : la table s'ouvre déjà remplie à son nom.
    // Le harnais reproduit le câblage de la page (état + réarmement de la demande).
    function Harnais() {
      const [cible, setCible] = useState<number | null>(null);
      return (
        <>
          <button type="button" onClick={() => setCible(12)}>
            demander
          </button>
          <AbsencePlanner focusTechId={cible} onFocusHandled={() => setCible(null)} />
        </>
      );
    }
    vi.mocked(Api.absences).mockResolvedValue([]);
    renderWithToast(<Harnais />);
    await screen.findByText(/Toute l'équipe est disponible/);

    await userEvent.click(screen.getByRole("button", { name: "demander" }));
    const select = await screen.findByRole("combobox", { name: "Technicien absent" });
    expect((select as HTMLSelectElement).value).toBe("12");
    expect(select).toHaveFocus(); // le curseur suit l'admin, il ne reste pas dans la liste
  });
});

describe("AbsenceRowStatus (état porté par la ligne du technicien)", () => {
  it("affiche la période et le remplaçant d'une absence en cours", () => {
    renderWithToast(
      <AbsenceRowStatus tech={TECHS[0]} absences={[absence()]} onDeclare={() => {}} />,
    );
    expect(screen.getByText(/Absent jusqu'au 22 août/)).toBeInTheDocument();
    expect(screen.getByText(/remplacé par Nadia/)).toBeInTheDocument();
  });

  it("signale l'absence sans remplaçant", () => {
    renderWithToast(
      <AbsenceRowStatus
        tech={TECHS[0]}
        absences={[absence({ replacement_ext_id: null, replacement_name: "" })]}
        onDeclare={() => {}}
      />,
    );
    expect(screen.getByText(/sans remplaçant/)).toBeInTheDocument();
  });

  it("propose de déclarer une absence pour CETTE personne", async () => {
    const onDeclare = vi.fn();
    renderWithToast(<AbsenceRowStatus tech={TECHS[0]} absences={[]} onDeclare={onDeclare} />);
    await userEvent.click(screen.getByRole("button", { name: "Déclarer une absence pour Adrien" }));
    expect(onDeclare).toHaveBeenCalledWith(11);
  });
});
