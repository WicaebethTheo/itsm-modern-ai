import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, setupSettled } from "@/lib/api";
import { Setup } from "./Setup";

// On mocke le module Api : exports réels conservés (ApiError, errorCode, constantes),
// seules les méthodes réseau utilisées par Setup sont remplacées.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, authStatus: vi.fn(), setup: vi.fn() },
  };
});

function renderSetup() {
  return render(
    <MemoryRouter initialEntries={["/setup"]}>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<div>PAGE-CONNEXION</div>} />
        <Route path="/" element={<div>DASHBOARD-OK</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Attend l'apparition du formulaire (la sonde `/api/auth/status` est asynchrone). */
async function form() {
  return await screen.findByLabelText("Adresse email");
}

/** Remplit les quatre champs. Les libellés SONT les sélecteurs : chaque champ a le sien. */
async function fill(opts: { email?: string; password?: string; confirm?: string; name?: string }) {
  const user = userEvent.setup();
  await form(); // le formulaire n'apparaît qu'une fois la sonde d'état revenue
  if (opts.email !== undefined) await user.type(await form(), opts.email);
  if (opts.name !== undefined) {
    await user.type(screen.getByLabelText("Nom affiché (optionnel)"), opts.name);
  }
  if (opts.password !== undefined) {
    await user.type(screen.getByLabelText("Mot de passe"), opts.password);
  }
  if (opts.confirm !== undefined) {
    await user.type(screen.getByLabelText("Confirmation du mot de passe"), opts.confirm);
  }
  return user;
}

const submitButton = () => screen.getByRole("button", { name: /Créer le compte/ });

describe("Setup — première installation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: false,
      auth_configured: false,
      setup_required: true,
    });
  });

  it("affiche un état de chargement le temps de sonder le moteur", async () => {
    let resolve: (v: never) => void = () => undefined;
    vi.mocked(Api.authStatus).mockReturnValue(
      new Promise((r) => {
        resolve = r as (v: never) => void;
      }),
    );
    renderSetup();
    expect(screen.getByText("Vérification de l'installation…")).toBeInTheDocument();
    resolve({ authenticated: false, auth_configured: false, setup_required: true } as never);
    expect(await form()).toBeInTheDocument();
  });

  it("place le focus sur le champ email dès l'affichage du formulaire", async () => {
    renderSetup();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Adresse email")),
    );
  });

  it("associe un label à CHACUN des quatre champs (dont les deux mots de passe)", async () => {
    renderSetup();
    await form();
    for (const label of [
      "Adresse email",
      "Nom affiché (optionnel)",
      "Mot de passe",
      "Confirmation du mot de passe",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it("crée le compte et arrive sur le tableau de bord", async () => {
    vi.mocked(Api.setup).mockResolvedValue({
      authenticated: true,
      auth_configured: true,
      setup_required: false,
    });
    renderSetup();
    const user = await fill({
      email: "admin@exemple.fr",
      name: "Théo",
      password: "correct-cheval-pile",
      confirm: "correct-cheval-pile",
    });
    await user.click(submitButton());
    expect(await screen.findByText("DASHBOARD-OK")).toBeInTheDocument();
    expect(Api.setup).toHaveBeenCalledWith({
      email: "admin@exemple.fr",
      password: "correct-cheval-pile",
      display_name: "Théo",
    });
  });

  it("omet le nom affiché quand il est laissé vide (champ optionnel)", async () => {
    vi.mocked(Api.setup).mockResolvedValue({
      authenticated: true,
      auth_configured: true,
      setup_required: false,
    });
    renderSetup();
    const user = await fill({
      email: "admin@exemple.fr",
      password: "correct-cheval-pile",
      confirm: "correct-cheval-pile",
    });
    await user.click(submitButton());
    await screen.findByText("DASHBOARD-OK");
    expect(Api.setup).toHaveBeenCalledWith({
      email: "admin@exemple.fr",
      password: "correct-cheval-pile",
    });
  });

  it("refuse un email mal formé sans appeler le moteur", async () => {
    renderSetup();
    const user = await fill({
      email: "pas-un-email",
      password: "correct-cheval-pile",
      confirm: "correct-cheval-pile",
    });
    await user.click(submitButton());
    expect(await screen.findByText("Adresse email invalide.")).toBeInTheDocument();
    expect(screen.getByLabelText("Adresse email")).toHaveAttribute("aria-invalid", "true");
    expect(Api.setup).not.toHaveBeenCalled();
  });

  it("refuse un mot de passe plus court que le minimum du moteur", async () => {
    renderSetup();
    const user = await fill({ email: "admin@exemple.fr", password: "court", confirm: "court" });
    await user.click(submitButton());
    // Le message est celui de la jauge (« encore N caractères »), pas un second message
    // rouge redondant : c'est déjà ce qu'elle affichait pendant la frappe.
    expect(await screen.findByText(/Encore 3 caractère/)).toBeInTheDocument();
    expect(screen.getByLabelText("Mot de passe")).toHaveAttribute("aria-invalid", "true");
    expect(Api.setup).not.toHaveBeenCalled();
  });

  it("lève le signalement de longueur dès que le mot de passe s'allonge", async () => {
    renderSetup();
    const user = await fill({ email: "admin@exemple.fr", password: "court", confirm: "court" });
    await user.click(submitButton());
    expect(screen.getByLabelText("Mot de passe")).toHaveAttribute("aria-invalid", "true");
    await user.type(screen.getByLabelText("Mot de passe"), "-mais-plus-long");
    expect(screen.getByLabelText("Mot de passe")).not.toHaveAttribute("aria-invalid");
  });

  it("signale une confirmation qui ne correspond pas", async () => {
    renderSetup();
    const user = await fill({
      email: "admin@exemple.fr",
      password: "correct-cheval-pile",
      confirm: "correct-cheval-pilf",
    });
    await user.click(submitButton());
    expect(
      await screen.findByText("Les deux mots de passe ne correspondent pas."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Confirmation du mot de passe")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(Api.setup).not.toHaveBeenCalled();
  });

  it("invite à se connecter quand un compte existe déjà (409)", async () => {
    vi.mocked(Api.setup).mockRejectedValue(
      new ApiError(409, { detail: { code: "already_configured", message: "déjà configuré" } }),
    );
    renderSetup();
    const user = await fill({
      email: "admin@exemple.fr",
      password: "correct-cheval-pile",
      confirm: "correct-cheval-pile",
    });
    await user.click(submitButton());
    expect(
      await screen.findByText("Un compte administrateur existe déjà sur ce moteur."),
    ).toBeInTheDocument();
    // Le 409 fait foi : /login ne doit plus renvoyer ici, même si le statut est périmé.
    expect(setupSettled.get()).toBe(true);
    // Le formulaire n'est plus soumettable : on propose la seule issue utile.
    await user.click(screen.getByRole("button", { name: "Aller à la connexion" }));
    expect(await screen.findByText("PAGE-CONNEXION")).toBeInTheDocument();
  });

  it("annonce le délai d'attente et verrouille l'envoi sur un 429", async () => {
    vi.mocked(Api.setup).mockRejectedValue(
      new ApiError(
        429,
        { detail: { code: "too_many_attempts", message: "Trop de tentatives." } },
        45,
      ),
    );
    renderSetup();
    const user = await fill({
      email: "admin@exemple.fr",
      password: "correct-cheval-pile",
      confirm: "correct-cheval-pile",
    });
    await user.click(submitButton());
    expect(await screen.findByText(/Réessayez dans 45 secondes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Réessayez dans 45 s/ })).toBeDisabled();
  });

  it("distingue une panne réseau d'un refus d'installation", async () => {
    vi.mocked(Api.setup).mockRejectedValue(
      new ApiError(502, { detail: { message: "Passerelle injoignable" } }),
    );
    renderSetup();
    const user = await fill({
      email: "admin@exemple.fr",
      password: "correct-cheval-pile",
      confirm: "correct-cheval-pile",
    });
    await user.click(submitButton());
    expect(await screen.findByText("Passerelle injoignable")).toBeInTheDocument();
    expect(
      screen.queryByText("Un compte administrateur existe déjà sur ce moteur."),
    ).not.toBeInTheDocument();
  });

  it("reporte un 422 sur le champ fautif plutôt qu'en bandeau générique", async () => {
    vi.mocked(Api.setup).mockRejectedValue(
      new ApiError(422, {
        detail: { code: "invalid_password", message: "Mot de passe refusé par le moteur." },
      }),
    );
    renderSetup();
    const user = await fill({
      email: "admin@exemple.fr",
      password: "correct-cheval-pile",
      confirm: "correct-cheval-pile",
    });
    await user.click(submitButton());
    expect(await screen.findByText("Mot de passe refusé par le moteur.")).toBeInTheDocument();
    expect(screen.getByLabelText("Mot de passe")).toHaveAttribute("aria-invalid", "true");
  });

  it("propose de réessayer quand le moteur est injoignable au chargement", async () => {
    vi.mocked(Api.authStatus).mockRejectedValueOnce(new Error("réseau"));
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: false,
      auth_configured: false,
      setup_required: true,
    });
    renderSetup();
    expect(await screen.findByText("Moteur injoignable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await form()).toBeInTheDocument();
  });

  it("renvoie vers la connexion si l'installation est déjà faite", async () => {
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: false,
      auth_configured: true,
      setup_required: false,
    });
    renderSetup();
    expect(await screen.findByText("PAGE-CONNEXION")).toBeInTheDocument();
  });

  it("renvoie vers le tableau de bord si une session est déjà ouverte", async () => {
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: true,
      auth_configured: true,
      setup_required: false,
    });
    renderSetup();
    expect(await screen.findByText("DASHBOARD-OK")).toBeInTheDocument();
  });

  it("ne renvoie jamais un moteur muet (champ absent) vers la création de compte", async () => {
    // Moteur antérieur à cette page : pas de `setup_required` → surtout pas de formulaire.
    vi.mocked(Api.authStatus).mockResolvedValue({ authenticated: false, auth_configured: true });
    renderSetup();
    expect(await screen.findByText("PAGE-CONNEXION")).toBeInTheDocument();
  });

  it("bascule l'affichage du mot de passe sans jamais le pré-remplir ailleurs", async () => {
    renderSetup();
    const user = await fill({ password: "correct-cheval-pile" });
    const field = screen.getByLabelText("Mot de passe");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "new-password");
    await user.click(screen.getByRole("button", { name: "Afficher le mot de passe" }));
    expect(screen.getByLabelText("Mot de passe")).toHaveAttribute("type", "text");
  });

  it("guide la robustesse du mot de passe sans bloquer l'envoi", async () => {
    vi.mocked(Api.setup).mockResolvedValue({
      authenticated: true,
      auth_configured: true,
      setup_required: false,
    });
    renderSetup();
    // « motdepasse » : 10 caractères — accepté par le moteur, mais signalé comme courant.
    const user = await fill({
      email: "admin@exemple.fr",
      password: "motdepasse",
      confirm: "motdepasse",
    });
    expect(screen.getByText(/mot très courant/)).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());
    expect(await screen.findByText("DASHBOARD-OK")).toBeInTheDocument();
  });
});
