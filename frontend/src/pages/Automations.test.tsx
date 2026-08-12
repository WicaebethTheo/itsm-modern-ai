import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type RetentionView } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { Automations } from "./Automations";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, retention: vi.fn(), updateRetention: vi.fn(), runRetention: vi.fn() },
  };
});

const RETENTION: RetentionView = {
  enabled: true,
  decisions_days: 365,
  llm_calls_days: 90,
  hour_utc: 3,
  last_run_at: "2026-08-08T03:00:00Z",
  last_decisions_deleted: 12,
  last_llm_calls_deleted: 47,
  last_run_by: "scheduler",
};

/** `window.confirm` n'existe pas dans jsdom : on l'espionne pour chaque test. */
function confirmeAvec(reponse: boolean) {
  return vi.spyOn(window, "confirm").mockReturnValue(reponse);
}

describe("Automations — purge RGPD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.retention).mockResolvedValue(RETENTION);
    vi.mocked(Api.updateRetention).mockResolvedValue(RETENTION);
    vi.mocked(Api.runRetention).mockResolvedValue({
      decisions_deleted: 12,
      llm_calls_deleted: 47,
      ran_at: "2026-08-09T10:00:00Z",
      view: RETENTION,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("affiche les réglages courants et la dernière exécution", async () => {
    renderWithToast(<Automations />);
    expect(await screen.findByLabelText(/Rétention Journal/)).toHaveValue(365);
    expect(screen.getByLabelText(/Rétention appels LLM/)).toHaveValue(90);
    expect(screen.getByLabelText(/Heure d'exécution/)).toHaveValue(3);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/par scheduler/)).toBeInTheDocument();
  });

  // ── Le chemin destructif ────────────────────────────────────────────────────────
  // La purge supprime DÉFINITIVEMENT des lignes en base. Rien, jusqu'ici, ne vérifiait
  // que le garde-fou de confirmation existait — ni surtout qu'un refus arrêtait tout.

  it("ANNULER la confirmation n'exécute AUCUNE purge", async () => {
    const confirm = confirmeAvec(false);
    renderWithToast(<Automations />);
    await userEvent.click(await screen.findByRole("button", { name: "Exécuter maintenant" }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(Api.runRetention).not.toHaveBeenCalled();
  });

  it("la confirmation ANNONCE les fenêtres réellement appliquées", async () => {
    // Une confirmation générique (« êtes-vous sûr ? ») ne permet pas de se rendre compte
    // qu'on s'apprête à purger sur une fenêtre qu'on vient de saisir par erreur.
    const confirm = confirmeAvec(false);
    renderWithToast(<Automations />);
    await userEvent.click(await screen.findByRole("button", { name: "Exécuter maintenant" }));

    const message = confirm.mock.calls[0][0] as string;
    expect(message).toContain("365");
    expect(message).toContain("90");
    expect(message).toMatch(/définitivement/i);
  });

  it("confirmée, la purge s'exécute et rend compte de ce qui a été supprimé", async () => {
    confirmeAvec(true);
    renderWithToast(<Automations />);
    await userEvent.click(await screen.findByRole("button", { name: "Exécuter maintenant" }));

    await waitFor(() => expect(Api.runRetention).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/12 décision\(s\), 47 appel\(s\) LLM supprimés/),
    ).toBeInTheDocument();
    // Les réglages sont rechargés : les compteurs « dernière exécution » doivent bouger.
    expect(Api.retention).toHaveBeenCalledTimes(2);
  });

  it("un échec de purge est REMONTÉ, jamais avalé", async () => {
    confirmeAvec(true);
    vi.mocked(Api.runRetention).mockRejectedValue(new Error("Base verrouillée"));
    renderWithToast(<Automations />);
    await userEvent.click(await screen.findByRole("button", { name: "Exécuter maintenant" }));

    expect(await screen.findByText("Base verrouillée")).toBeInTheDocument();
  });

  it("la confirmation reflète une fenêtre ENREGISTRÉE, pas un brouillon non sauvé", async () => {
    // Piège : saisir 10 j sans enregistrer, puis lancer la purge. Le serveur applique la
    // valeur PERSISTÉE (365) — la confirmation doit annoncer celle-là, sinon elle ment
    // sur ce qui va réellement être supprimé.
    const confirm = confirmeAvec(false);
    renderWithToast(<Automations />);
    const champ = await screen.findByLabelText(/Rétention Journal/);
    await userEvent.clear(champ);
    await userEvent.type(champ, "10");
    await userEvent.click(screen.getByRole("button", { name: "Exécuter maintenant" }));

    expect(confirm.mock.calls[0][0]).toContain("365");
  });

  // ── Réglages ────────────────────────────────────────────────────────────────────

  it("le bouton Enregistrer reste inerte tant que rien n'a changé", async () => {
    renderWithToast(<Automations />);
    expect(await screen.findByRole("button", { name: "Enregistrer" })).toBeDisabled();
  });

  it("enregistre les quatre réglages modifiés", async () => {
    renderWithToast(<Automations />);
    const champ = await screen.findByLabelText(/Rétention appels LLM/);
    await userEvent.clear(champ);
    await userEvent.type(champ, "30");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateRetention).toHaveBeenCalledTimes(1));
    expect(Api.updateRetention).toHaveBeenCalledWith({
      enabled: true,
      decisions_days: 365,
      llm_calls_days: 30,
      hour_utc: 3,
    });
    expect(await screen.findByText("Réglages enregistrés.")).toBeInTheDocument();
  });

  it("désactiver la purge est un réglage comme un autre — pas de confirmation, mais un envoi explicite", async () => {
    renderWithToast(<Automations />);
    // `Toggle` est un `role="switch"` (bouton + aria-checked), pas un `<input checkbox>`.
    await userEvent.click(await screen.findByRole("switch", { name: /Purge automatique/ }));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateRetention).toHaveBeenCalled());
    expect(vi.mocked(Api.updateRetention).mock.calls[0][0]).toMatchObject({ enabled: false });
  });

  it("une rétention à 0 est transmise telle quelle (0 = ne pas purger)", async () => {
    // 0 n'est pas « vide » : c'est la désactivation explicite de la purge d'une table.
    // Un `|| 0` mal placé côté UI le transformerait silencieusement en autre chose.
    renderWithToast(<Automations />);
    const champ = await screen.findByLabelText(/Rétention Journal/);
    await userEvent.clear(champ);
    await userEvent.type(champ, "0");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(Api.updateRetention).toHaveBeenCalled());
    expect(vi.mocked(Api.updateRetention).mock.calls[0][0]).toMatchObject({ decisions_days: 0 });
  });

  it("affiche l'erreur de chargement au lieu d'une page muette", async () => {
    vi.mocked(Api.retention).mockRejectedValue(new Error("API 503"));
    renderWithToast(<Automations />);
    expect(await screen.findByText("API 503")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exécuter maintenant" })).not.toBeInTheDocument();
  });

  it("une erreur de chargement se RATTRAPE sans recharger la page", async () => {
    // Sans bouton, la seule issue d'un 503 transitoire était un F5 : `useResource`
    // expose pourtant reload().
    vi.mocked(Api.retention).mockRejectedValueOnce(new Error("API 503"));
    renderWithToast(<Automations />);
    await userEvent.click(await screen.findByRole("button", { name: "Réessayer" }));

    expect(await screen.findByLabelText(/Rétention Journal/)).toHaveValue(365);
    expect(screen.queryByText("API 503")).not.toBeInTheDocument();
  });
});

describe("Automations — carte « à venir »", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.retention).mockResolvedValue(RETENTION);
  });

  afterEach(() => vi.restoreAllMocks());

  it("le sous-titre décrit ce que la carte contient RÉELLEMENT", async () => {
    // Piège corrigé : « 4 prévues · 1 active » comptait la purge, rendue dans la carte
    // du dessus — la carte annonçait donc une ligne de plus qu'elle n'en liste.
    renderWithToast(<Automations />);
    expect(
      await screen.findByText("3 automatisations prévues, aucune encore disponible"),
    ).toBeInTheDocument();
  });

  it("aucune ligne ne prétend avoir une « dernière exécution »", async () => {
    renderWithToast(<Automations />);
    await screen.findByText("Rapport hebdomadaire par email");
    // Le seul « Dernière exécution » légitime est celui de la purge (carte du dessus).
    expect(screen.getAllByText(/Dernière exécution/)).toHaveLength(1);
    // La description remplace le tiret, et n'est plus masquée sous 640 px.
    const desc = screen.getByText("Envoi planifié (SMTP) du bilan de triage au DSI");
    expect(desc).toBeInTheDocument();
    expect(desc.className).not.toMatch(/\bhidden\b/);
  });

  it("remplace l'affordance morte « + Nouvelle » par un marqueur explicite", async () => {
    renderWithToast(<Automations />);
    expect(await screen.findByText("Feuille de route")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Nouvelle" })).not.toBeInTheDocument();
  });
});
