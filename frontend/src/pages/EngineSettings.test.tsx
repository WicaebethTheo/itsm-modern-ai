import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type ConfigView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";
import { EngineSettings } from "./EngineSettings";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, getConfig: vi.fn(), updateConfig: vi.fn(), getLicense: vi.fn() },
  };
});

/** La page renvoie vers /cost (lien « Voir la consommation ») → contexte routeur requis. */
function renderPage(ui: ReactElement = <EngineSettings />) {
  return renderWithToast(<MemoryRouter>{ui}</MemoryRouter>);
}

/** `window.confirm` n'existe pas dans jsdom : on l'espionne pour chaque test. */
function confirmeAvec(reponse: boolean) {
  return vi.spyOn(window, "confirm").mockReturnValue(reponse);
}

function config(over: Partial<ConfigView> = {}): ConfigView {
  return {
    ...demo.config,
    mask_email: "true",
    mask_phone: "true",
    mask_iban: "true",
    mask_secret: "true",
    ...over,
  };
}

/**
 * Attend que la config soit RÉELLEMENT chargée, puis renvoie le switch e-mail.
 * Attendre un contrôle quelconque ne suffit pas : le formulaire est rendu dès le premier
 * passage avec les défauts locaux, et une assertion posée là passait avant même l'arrivée
 * de la config. On attend donc une valeur qui ne peut venir que du serveur.
 */
async function attendreChargement() {
  await screen.findByDisplayValue("0.7"); // confidence_threshold de la config
  return screen.getByRole("switch", { name: "Masquer les e-mails" });
}

describe("EngineSettings — masquage PII", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Config chargée : tous les masques ON (défaut sûr).
    vi.mocked(Api.getConfig).mockResolvedValue(config());
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.getLicense).mockResolvedValue(demo.license);
  });

  it("reflète l'état initial des masques (toggles cochés)", async () => {
    renderPage();
    const email = await attendreChargement();
    expect(email).toHaveAttribute("aria-checked", "true");
  });

  it("désactiver un motif et enregistrer envoie mask_email=false", async () => {
    renderPage();
    const email = await attendreChargement();
    await userEvent.click(email); // ON → OFF
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Api.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mask_email: false,
        mask_phone: true,
        mask_iban: true,
        mask_secret: true,
      }),
    );
  });

  it("affiche un message de confirmation après enregistrement, en disant QUAND ça s'applique", async () => {
    renderPage();
    const email = await attendreChargement();
    // Le bouton n'est actif que si quelque chose a changé : on touche un contrôle d'abord.
    await userEvent.click(email);
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    const toast = await screen.findByText(/Réglages enregistrés/);
    expect(toast).toHaveTextContent(/polling est appliqué immédiatement/);
    expect(toast).toHaveTextContent(/prochain cycle/);
  });
});

describe("EngineSettings — le mode qui ÉCRIT dans GLPI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockResolvedValue(config());
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.getLicense).mockResolvedValue(demo.license);
  });

  it("aucun avertissement tant que le mode reste « suggestion »", async () => {
    renderPage();
    await attendreChargement();
    expect(screen.queryByText(/modifiera/)).not.toBeInTheDocument();
  });

  // Régression : le bandeau ne se déclenchait qu'en full_auto, alors que semi_auto mute
  // AUSSI les tickets dès que la confiance dépasse le seuil (domain/modes.resolve_action).
  it("semi_auto déclenche le bandeau d'écriture réelle, comme full_auto", async () => {
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "semi_auto");

    expect(screen.getByText(/semi_auto par défaut/)).toBeInTheDocument();
    expect(screen.getByText(/modifiera réellement les tickets GLPI/)).toBeInTheDocument();
  });

  it("full_auto garde son bandeau", async () => {
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "full_auto");
    expect(screen.getByText(/full_auto par défaut/)).toBeInTheDocument();
  });

  it("le marqueur de ton de l'en-tête suit le mode choisi (neutre → ambre → rouge)", async () => {
    renderPage();
    await attendreChargement();
    // Le marqueur est un <span> (Tag) ; « Full-auto » est aussi le libellé d'une <option>,
    // d'où le filtrage sur le type d'élément.
    const marqueur = (texte: string) =>
      screen.getAllByText(texte).filter((el) => el.tagName === "SPAN")[0];

    expect(marqueur("Suggestion")).toHaveClass("text-muted-foreground");

    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "semi_auto");
    expect(marqueur("Semi-auto")).toHaveClass("text-warning");

    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "full_auto");
    expect(marqueur("Full-auto")).toHaveClass("text-destructive");
  });

  it("ANNULER la confirmation n'enregistre RIEN", async () => {
    const confirm = confirmeAvec(false);
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "semi_auto");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(Api.updateConfig).not.toHaveBeenCalled();
  });

  it("la confirmation ÉNONCE la conséquence, pas un « êtes-vous sûr ? »", async () => {
    const confirm = confirmeAvec(false);
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "semi_auto");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    const message = confirm.mock.calls[0][0] as string;
    expect(message).toContain("catégorie, priorité, assignation");
    expect(message).toContain("répondra au demandeur");
    expect(message).toContain("sans mode explicite");
  });

  it("confirmée, la bascule est bien envoyée au backend", async () => {
    confirmeAvec(true);
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "semi_auto");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(Api.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ execution_mode_default: "semi_auto" }),
    );
  });

  // La confirmation garde le franchissement suggestion → écriture. Une instance DÉJÀ en
  // semi_auto n'arme rien de neuf : la redemander à chaque enregistrement la banaliserait.
  it("aucune confirmation quand le mode ENREGISTRÉ écrit déjà", async () => {
    const confirm = confirmeAvec(true);
    vi.mocked(Api.getConfig).mockResolvedValue(config({ execution_mode_default: "semi_auto" }));
    renderPage();
    const email = await attendreChargement();
    await userEvent.click(email);
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("revenir à « suggestion » ne demande aucune confirmation", async () => {
    const confirm = confirmeAvec(true);
    vi.mocked(Api.getConfig).mockResolvedValue(config({ execution_mode_default: "full_auto" }));
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "suggestion");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("EngineSettings — brouillon, état modifié, indications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockResolvedValue(config());
    vi.mocked(Api.updateConfig).mockResolvedValue(demo.config);
    vi.mocked(Api.getLicense).mockResolvedValue(demo.license);
  });

  // Régression : les valeurs réelles n'étaient que des `placeholder` — champ visuellement
  // vide, valeur en gris clair, impossible de distinguer « réglé » de « suggéré ».
  it("les champs portent la VALEUR enregistrée, pas un placeholder", async () => {
    renderPage();
    await attendreChargement();
    expect(screen.getByLabelText(/Seuil de confiance/)).toHaveValue(0.7);
    expect(screen.getByLabelText(/Plafond de coût/)).toHaveValue(5);
    expect(screen.getByLabelText(/Seuil du mode semi-auto/)).toHaveValue(0.9);
    expect(screen.getByLabelText(/Intervalle de polling/)).toHaveValue(60);
    // Plus aucune répétition « Actuel : … ».
    expect(screen.queryByText(/Actuel :/)).not.toBeInTheDocument();
  });

  it("annonce « Tout est enregistré. » puis « Modifications non enregistrées. »", async () => {
    renderPage();
    await attendreChargement();
    expect(screen.getByText("Tout est enregistré.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();

    // `fireEvent.change` plutôt que `type` : jsdom assainit les états intermédiaires
    // invalides d'un <input type="number"> (« 0. » devient «  »).
    fireEvent.change(screen.getByLabelText(/Seuil de confiance/), { target: { value: "0.8" } });

    expect(screen.getByText("Modifications non enregistrées.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeEnabled();
  });

  it("la barre d'enregistrement DIT qu'une modification armerait l'écriture", async () => {
    renderPage();
    await attendreChargement();
    await userEvent.selectOptions(screen.getByLabelText("Mode par défaut"), "semi_auto");

    const bar = screen.getByText(/dont le passage en écriture réelle dans GLPI/);
    expect(bar).toHaveClass("text-destructive");
  });

  it("avertit quand le seuil semi-auto est INFÉRIEUR au seuil de confiance (sans effet)", async () => {
    renderPage();
    await attendreChargement();
    const semi = screen.getByLabelText(/Seuil du mode semi-auto/);
    fireEvent.change(semi, { target: { value: "0.5" } });

    expect(screen.getByText(/n'a aucun effet/)).toBeInTheDocument();
  });

  it("le seuil semi-auto au-dessus du seuil de confiance n'avertit pas", async () => {
    renderPage();
    await attendreChargement();
    expect(screen.queryByText(/n'a aucun effet/)).not.toBeInTheDocument();
  });

  it("le plafond de coût dit ce qui se passe une fois atteint et renvoie vers les coûts", async () => {
    renderPage();
    await attendreChargement();
    expect(screen.getByText(/suspend les appels LLM facturables/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voir la consommation" })).toHaveAttribute(
      "href",
      "/cost",
    );
  });

  it("le seuil de confiance explique le repli « à trier » avec des repères chiffrés", async () => {
    renderPage();
    await attendreChargement();
    const hint = screen.getByText(/Barrière d'entrée du moteur/);
    expect(hint).toHaveTextContent(/à trier/);
    expect(hint).toHaveTextContent(/non tranché/);
    expect(hint).toHaveTextContent(/0,5 permissif/);
  });

  it("une saisie faite PENDANT le rechargement n'est pas écrasée", async () => {
    // `save()` déclenche `cfg.reload()` sans pouvoir l'attendre (`useResource.reload` ne
    // rend pas de promesse) et rouvre le formulaire aussitôt : à l'arrivée de la réponse,
    // l'effet d'initialisation réécrivait le brouillon SANS CONDITION. Tout ce qui avait
    // été tapé pendant l'aller-retour disparaissait en silence.
    let repondre: (c: ConfigView) => void = () => {};
    vi.mocked(Api.getConfig)
      .mockResolvedValueOnce(config())
      .mockImplementationOnce(
        () =>
          new Promise<ConfigView>((r) => {
            repondre = r;
          }),
      );
    renderPage();
    await attendreChargement();

    fireEvent.change(screen.getByLabelText(/Seuil de confiance/), { target: { value: "0.8" } });
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(Api.updateConfig).toHaveBeenCalledTimes(1));

    // Le rechargement est EN VOL : l'admin continue de saisir.
    fireEvent.change(screen.getByLabelText(/Nom de l'assistant/), { target: { value: "Astrid" } });
    repondre(config());

    await waitFor(() => expect(Api.getConfig).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText(/Nom de l'assistant/)).toHaveValue("Astrid");
    expect(screen.getByText("Modifications non enregistrées.")).toBeInTheDocument();
  });

  it("sans saisie en cours, le rechargement REPREND la valeur du serveur", async () => {
    // La garde ne doit pas figer le brouillon : le serveur reste la référence (il peut
    // avoir normalisé une valeur), tant que rien n'attend d'être enregistré.
    vi.mocked(Api.getConfig)
      .mockResolvedValueOnce(config())
      .mockResolvedValue(config({ assistant_name: "Normalisé par le serveur" }));
    renderPage();
    await attendreChargement();

    fireEvent.change(screen.getByLabelText(/Seuil de confiance/), { target: { value: "0.8" } });
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() =>
      expect(screen.getByLabelText(/Nom de l'assistant/)).toHaveValue("Normalisé par le serveur"),
    );
    expect(screen.getByText("Tout est enregistré.")).toBeInTheDocument();
  });

  // Le <select> du mode par défaut gardait une chaîne de classes recopiée à la main, qui
  // avait déjà divergé de `components/ui/select.tsx` : ni largeur pleine, ni rembourrage
  // vertical, ni état désactivé — sur le réglage qui arme l'écriture dans GLPI.
  it("le mode par défaut passe par la primitive Select", async () => {
    renderPage();
    await attendreChargement();
    const select = screen.getByLabelText("Mode par défaut");
    expect(select).toHaveClass("w-full", "py-1", "disabled:opacity-50");
  });

  // Le composant Field accepte `htmlFor` depuis toujours ; aucun champ ne le passait, donc
  // le <select> de mode n'avait aucun nom accessible et les libellés ne focalisaient rien.
  it("chaque champ a un nom accessible", async () => {
    renderPage();
    await attendreChargement();
    for (const nom of [
      /Seuil de confiance/,
      /Plafond de coût/,
      /Tentatives LLM/,
      "Mode par défaut",
      /Seuil du mode semi-auto/,
      /Intervalle de polling/,
      /Fenêtre \(jours\)/,
      /âge max d'un ticket/,
      /Ton de la réponse/,
      /Nom de l'assistant/,
      /Consignes de routage/,
    ]) {
      expect(screen.getByLabelText(nom)).toBeInTheDocument();
    }
  });
});
