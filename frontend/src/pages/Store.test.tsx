import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type LicenseView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { Store } from "./Store";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      getLicense: vi.fn(),
      setLicense: vi.fn(),
      deleteLicense: vi.fn(),
      version: vi.fn(),
    },
  };
});

// Code SUPPORTER présent, non licencié : le code est installé (installed:true) mais aucune
// licence valide → l'activation par clé est proposée.
const ENT_UNLICENSED: LicenseView = {
  edition: "community",
  valid: false,
  customer: null,
  issued_at: null,
  expires_at: null,
  error: null,
  features: demo.license.features.map((f) => ({
    ...f,
    installed: true,
    entitled: false,
    active: false,
  })),
};

// Code SUPPORTER présent, licence valide → tout ce qui PEUT l'être est actif.
// `active: !coming_soon` reproduit l'invariant du backend (`routes/license.py`) : un module
// annoncé n'a aucune surface d'usage, la licence ne le rend donc jamais actif.
const ENT_ACTIVE: LicenseView = {
  edition: "supporter",
  valid: true,
  customer: "ACME Corp",
  issued_at: "2026-01-01",
  expires_at: "2027-01-01",
  error: null,
  features: demo.license.features.map((f) => ({
    ...f,
    installed: true,
    entitled: true,
    active: !f.coming_soon,
  })),
};

// Code SUPPORTER présent, clé refusée (valid:false) → bannière d'erreur, activation visible.
const ENT_INVALID: LicenseView = { ...ENT_UNLICENSED, valid: false, error: "signature invalide" };

describe("Store (licence open-core)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.setLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.deleteLicense).mockResolvedValue(demo.license);
    vi.mocked(Api.version).mockResolvedValue(demo.version);
  });

  it("Community : encart d'activation Supporter + features verrouillées", async () => {
    renderWithToast(<Store />);
    expect(await screen.findByText("Community")).toBeInTheDocument();
    // Une SEULE carte d'activation (le code Supporter est toujours livré : la branche
    // « code absent » ne pouvait jamais s'afficher chez un exploitant).
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByLabelText("Clé de licence")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activer" })).toBeInTheDocument();
    // L'argument de souveraineté doit être visible ICI (il vivait dans la branche morte).
    expect(
      screen.getByText(/vérifiée hors-ligne \(Ed25519, aucun appel sortant\)/),
    ).toBeInTheDocument();
    // Un SEUL module a une surface d'usage : il porte le verrou « Supporter ». Les deux
    // autres sont « Prévu » — un verrou dessus promettrait qu'une clé les déverrouille.
    expect(screen.getAllByText("Supporter")).toHaveLength(1);
    expect(screen.getAllByText("Prévu")).toHaveLength(2);
    expect(screen.queryByText("Débloqué")).not.toBeInTheDocument();
    // Résumé chiffré en tête : « qu'est-ce qui est actif chez moi ? » en une ligne, sans
    // gonfler le compte des modules verrouillables avec deux promesses.
    expect(
      screen.getByText("1 module(s) Supporter installés mais verrouillés"),
    ).toBeInTheDocument();
    expect(screen.getByText("2 module(s) à venir")).toBeInTheDocument();
    // Anti-DRM : le code est déjà là, la clé autorise, elle ne télécharge rien.
    expect(screen.getByText(/DÉJÀ installé dans cette image/)).toBeInTheDocument();
    expect(
      screen.getAllByText("Code installé, en attente d'une licence qui l'autorise.").length,
    ).toBe(1);
  });

  it("Code Supporter présent : active une clé valide → licence Supporter + features débloquées", async () => {
    vi.mocked(Api.setLicense).mockResolvedValue(ENT_ACTIVE);
    vi.mocked(Api.getLicense).mockResolvedValueOnce(ENT_UNLICENSED).mockResolvedValue(ENT_ACTIVE);
    renderWithToast(<Store />);
    // Sur le code Supporter non licencié, le champ d'activation est présent.
    await screen.findByRole("textbox");

    await userEvent.type(screen.getByRole("textbox"), "JETON-VALIDE");
    await userEvent.click(screen.getByRole("button", { name: "Activer" }));

    await waitFor(() => expect(Api.setLicense).toHaveBeenCalledWith("JETON-VALIDE"));
    expect(await screen.findByText("Supporter", { selector: "span" })).toBeInTheDocument();
    // UN seul module a une surface d'usage : les deux « à venir » restent « Prévu ».
    // Trois pastilles vertes pour deux promesses, c'était payer pour du vert.
    expect(await screen.findAllByText("Débloqué")).toHaveLength(1);
    expect(screen.getAllByText("Prévu")).toHaveLength(2);
    expect(await screen.findByText("Licence activée.")).toBeInTheDocument();
    // Résumé chiffré : le DÉNOMINATEUR ne compte que les modules qui peuvent être actifs.
    // « 3 sur 3 » annonçait en réussite deux promesses que le catalogue, deux cartes plus
    // bas, décrit comme « pas encore de surface d'usage ».
    expect(screen.getByText("1 module(s) actif(s) sur 1")).toBeInTheDocument();
    expect(screen.getByText("2 module(s) à venir")).toBeInTheDocument();
    expect(screen.getByText("Jusqu'au 2027-01-01")).toBeInTheDocument();
  });

  it("licence valide qui n'active RIEN : clé visible, retirable, et catalogue non accusateur", async () => {
    // Deux régressions dans un seul état : (1) un client licencié à qui il manque une clé
    // de feature lisait « en attente d'une licence » — faux, et vexant ; (2) l'écran se
    // basait sur « quelque chose est actif » pour montrer la clé ET pour dégriser
    // « Réinitialiser » — donc, licence valide n'autorisant rien, plus AUCUN chemin
    // d'interface pour retirer une clé pourtant stockée.
    const partial: LicenseView = {
      ...ENT_ACTIVE,
      features: ENT_ACTIVE.features.map((f) =>
        f.key === "pii_advanced" ? { ...f, entitled: false, active: false } : f,
      ),
    };
    vi.mocked(Api.getLicense).mockResolvedValue(partial);
    renderWithToast(<Store />);
    // La clé stockée reste à l'écran (titulaire, échéance), et le dit sans mentir.
    await screen.findByText("ACME Corp");
    expect(screen.getByText("Sans module actif")).toBeInTheDocument();
    expect(screen.getByText(/n'autorise aucun module UTILISABLE/)).toBeInTheDocument();
    // Le retrait reste possible : c'est le seul chemin de sortie.
    expect(screen.getByRole("button", { name: "Réinitialiser" })).toBeEnabled();
    expect(screen.getByText("Non incluse dans votre licence actuelle.")).toBeInTheDocument();
    expect(
      screen.queryByText("Code installé, en attente d'une licence qui l'autorise."),
    ).not.toBeInTheDocument();
  });

  it("aucune clé stockée : « Réinitialiser » reste grisé (il n'y a rien à retirer)", async () => {
    vi.mocked(Api.getLicense).mockResolvedValue(ENT_UNLICENSED);
    renderWithToast(<Store />);
    await screen.findByLabelText("Clé de licence");
    expect(screen.getByRole("button", { name: "Réinitialiser" })).toBeDisabled();
  });

  it("clé refusée : « Réinitialiser » est actif (le backend a une raison à donner)", async () => {
    vi.mocked(Api.getLicense).mockResolvedValue(ENT_INVALID);
    renderWithToast(<Store />);
    await screen.findByText(/Licence invalide/);
    expect(screen.getByRole("button", { name: "Réinitialiser" })).toBeEnabled();
  });

  it("Code Supporter présent : clé invalide → bannière d'erreur traduite et actionnable", async () => {
    vi.mocked(Api.setLicense).mockResolvedValue(ENT_INVALID);
    vi.mocked(Api.getLicense).mockResolvedValueOnce(ENT_UNLICENSED).mockResolvedValue(ENT_INVALID);
    renderWithToast(<Store />);
    await screen.findByRole("textbox");

    await userEvent.type(screen.getByRole("textbox"), "JETON-POURRI");
    await userEvent.click(screen.getByRole("button", { name: "Activer" }));

    // Le message brut du backend (« signature invalide ») est traduit en conséquence
    // + geste à faire, au lieu d'être affiché en français quelle que soit la langue.
    expect(await screen.findByText(/Licence invalide/)).toBeInTheDocument();
    expect(screen.getByText(/demandez une clé ré-émise/)).toBeInTheDocument();
  });

  it("licence expirée : message dédié + date, sans reniflage de sous-chaîne", async () => {
    const expired: LicenseView = {
      ...ENT_UNLICENSED,
      customer: "ACME Corp",
      expires_at: "2026-01-01",
      error: "licence expirée",
    };
    vi.mocked(Api.getLicense).mockResolvedValue(expired);
    renderWithToast(<Store />);
    expect(await screen.findByText(/Licence expirée/)).toBeInTheDocument();
    expect(screen.getByText(/\(2026-01-01\)/)).toBeInTheDocument();
  });

  it("message backend inconnu : repli sur le texte brut (jamais d'écran muet)", async () => {
    vi.mocked(Api.getLicense).mockResolvedValue({
      ...ENT_UNLICENSED,
      error: "raison inédite du futur",
    });
    renderWithToast(<Store />);
    expect(await screen.findByText(/raison inédite du futur/)).toBeInTheDocument();
  });

  it("MAJ disponible (runtime docker) : la carte propose la commande docker", async () => {
    vi.mocked(Api.version).mockResolvedValue({
      ...demo.version,
      latest: "9.9.9",
      update_available: true,
      runtime: "docker",
    });
    renderWithToast(<Store />);
    expect(
      await screen.findByText("docker compose pull && docker compose up -d"),
    ).toBeInTheDocument();
    expect(screen.queryByText("./install.sh --update")).not.toBeInTheDocument();
  });

  it("MAJ disponible (runtime hôte) : la carte propose install.sh --update", async () => {
    vi.mocked(Api.version).mockResolvedValue({
      ...demo.version,
      latest: "9.9.9",
      update_available: true,
      runtime: "host",
    });
    renderWithToast(<Store />);
    expect(await screen.findByText("./install.sh --update")).toBeInTheDocument();
    expect(
      screen.queryByText("docker compose pull && docker compose up -d"),
    ).not.toBeInTheDocument();
  });

  it("Code Supporter présent : réinitialise la licence → retour Community", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(Api.getLicense).mockResolvedValueOnce(ENT_ACTIVE).mockResolvedValue(ENT_UNLICENSED);
    renderWithToast(<Store />);
    await screen.findByText("ACME Corp");

    await userEvent.click(screen.getByRole("button", { name: "Réinitialiser" }));

    await waitFor(() => expect(Api.deleteLicense).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Community")).toBeInTheDocument();
    expect(await screen.findByText("Licence réinitialisée.")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
