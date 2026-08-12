import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, MIN_PASSWORD_CHARS } from "@/lib/api";
import { Account } from "./Account";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, me: vi.fn(), changePassword: vi.fn() } };
});

const NOUVEAU = "n0uveau-mot-de-passe";

function renderAccount() {
  return render(
    <MemoryRouter initialEntries={["/account"]}>
      <Routes>
        <Route path="/account" element={<Account />} />
        <Route path="/login" element={<div>PAGE-CONNEXION</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Remplit le formulaire de rotation. Les libellés SONT les sélecteurs. */
async function fill(opts: { current?: string; next?: string; confirm?: string }) {
  const user = userEvent.setup();
  if (opts.current !== undefined) {
    await user.type(screen.getByLabelText("Mot de passe actuel"), opts.current);
  }
  if (opts.next !== undefined) {
    await user.type(screen.getByLabelText("Nouveau mot de passe"), opts.next);
  }
  if (opts.confirm !== undefined) {
    await user.type(screen.getByLabelText("Confirmation du nouveau mot de passe"), opts.confirm);
  }
  return user;
}

const submitButton = () => screen.getByRole("button", { name: "Changer le mot de passe" });

describe("Account — compte & sécurité", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.me).mockResolvedValue({ email: "admin@exemple.fr", display_name: "Théo" });
    vi.mocked(Api.changePassword).mockResolvedValue({ ok: true });
  });

  it("affiche l'identité du compte unique", async () => {
    renderAccount();
    expect(await screen.findByText("admin@exemple.fr")).toBeInTheDocument();
    expect(screen.getByText("Théo")).toBeInTheDocument();
  });

  it("ne propose AUCUNE gestion multi-comptes (le mono-compte est assumé)", async () => {
    renderAccount();
    await screen.findByText("admin@exemple.fr");
    expect(screen.queryByText(/Ajouter un utilisateur|Inviter|Rôle/)).not.toBeInTheDocument();
  });

  it("dit « (aucun) » plutôt que d'inventer un nom quand il n'y en a pas", async () => {
    vi.mocked(Api.me).mockResolvedValue({ email: "admin@exemple.fr", display_name: null });
    renderAccount();
    expect(await screen.findByText("(aucun)")).toBeInTheDocument();
  });

  it("prévient AVANT de valider que toutes les sessions vont tomber", async () => {
    renderAccount();
    expect(
      await screen.findByText(/toutes les sessions ouvertes sont fermées/i),
    ).toBeInTheDocument();
  });

  it("exige le mot de passe actuel", async () => {
    renderAccount();
    const user = await fill({ next: NOUVEAU, confirm: NOUVEAU });
    await user.click(submitButton());
    expect(screen.getByText("Saisissez votre mot de passe actuel.")).toBeInTheDocument();
    expect(Api.changePassword).not.toHaveBeenCalled();
  });

  it("refuse une confirmation qui diverge", async () => {
    renderAccount();
    const user = await fill({ current: "ancien-mot-passe", next: NOUVEAU, confirm: "autre-chose" });
    await user.click(submitButton());
    expect(screen.getByText("Les deux mots de passe ne correspondent pas.")).toBeInTheDocument();
    expect(Api.changePassword).not.toHaveBeenCalled();
  });

  it("laisse la JAUGE porter le refus quand le nouveau secret est trop court", async () => {
    renderAccount();
    const court = "x".repeat(MIN_PASSWORD_CHARS - 1);
    const user = await fill({ current: "ancien-mot-passe", next: court, confirm: court });
    await user.click(submitButton());
    expect(screen.getByLabelText("Nouveau mot de passe")).toHaveAttribute("aria-invalid", "true");
    expect(Api.changePassword).not.toHaveBeenCalled();
  });

  it("annonce la fermeture de TOUTES les sessions après un succès", async () => {
    renderAccount();
    const user = await fill({ current: "ancien-mot-passe", next: NOUVEAU, confirm: NOUVEAU });
    await user.click(submitButton());
    expect(Api.changePassword).toHaveBeenCalledWith("ancien-mot-passe", NOUVEAU);
    expect(await screen.findByText(/Toutes vos sessions sont fermées/)).toBeInTheDocument();
    // Le formulaire disparaît : le proposer encore serait un mensonge, la session est morte.
    expect(screen.queryByLabelText("Mot de passe actuel")).not.toBeInTheDocument();
  });

  it("offre le retour immédiat vers la connexion", async () => {
    renderAccount();
    const user = await fill({ current: "ancien-mot-passe", next: NOUVEAU, confirm: NOUVEAU });
    await user.click(submitButton());
    await user.click(await screen.findByRole("button", { name: "Aller à la connexion" }));
    expect(screen.getByText("PAGE-CONNEXION")).toBeInTheDocument();
  });

  it("vise le champ « actuel » quand le moteur refuse en 401", async () => {
    vi.mocked(Api.changePassword).mockRejectedValue(
      new ApiError(401, {
        detail: { code: "bad_credentials", message: "Mot de passe incorrect." },
      }),
    );
    renderAccount();
    const user = await fill({ current: "mauvais", next: NOUVEAU, confirm: NOUVEAU });
    await user.click(submitButton());
    expect(await screen.findByText("Mot de passe actuel incorrect.")).toBeInTheDocument();
    expect(screen.getByLabelText("Mot de passe actuel")).toHaveAttribute("aria-invalid", "true");
  });

  it("affiche un décompte sur un 429 (même limiteur que /login)", async () => {
    vi.mocked(Api.changePassword).mockRejectedValue(
      new ApiError(
        429,
        { detail: { code: "too_many_attempts", message: "Trop de tentatives." } },
        30,
      ),
    );
    renderAccount();
    const user = await fill({ current: "ancien-mot-passe", next: NOUVEAU, confirm: NOUVEAU });
    await user.click(submitButton());
    expect(await screen.findByText(/Réessayez dans 30 secondes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Réessayez dans 30 s/ })).toBeDisabled();
  });
});

describe("Account — retour automatique vers la connexion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.me).mockResolvedValue({ email: "admin@exemple.fr", display_name: "Théo" });
    vi.mocked(Api.changePassword).mockResolvedValue({ ok: true });
    // `shouldAdvanceTime` : sans lui, les `waitFor` de Testing Library (qui s'appuient sur
    // de vrais délais) attendent une horloge gelée et le test expire.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => vi.useRealTimers());

  it("renvoie seul vers /login une fois le message lu", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderAccount();
    await user.type(screen.getByLabelText("Mot de passe actuel"), "ancien-mot-passe");
    await user.type(screen.getByLabelText("Nouveau mot de passe"), NOUVEAU);
    await user.type(screen.getByLabelText("Confirmation du nouveau mot de passe"), NOUVEAU);
    await user.click(submitButton());
    await screen.findByText(/Toutes vos sessions sont fermées/);
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText("PAGE-CONNEXION")).toBeInTheDocument();
  });
});
