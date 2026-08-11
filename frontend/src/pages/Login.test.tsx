import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, setupSettled } from "@/lib/api";
import { Login } from "./Login";

// On mocke le module Api : on garde les exports réels (asBool, types…) et on
// remplace seulement les méthodes réseau utilisées par Login.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, authStatus: vi.fn(), login: vi.fn() },
  };
});

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<div>PAGE-INSTALLATION</div>} />
        <Route path="/" element={<div>DASHBOARD-OK</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Saisit les identifiants. Les deux champs ont un vrai label : plus de `querySelector`. */
async function signIn(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Adresse email"), email);
  await user.type(screen.getByLabelText("Mot de passe"), password);
  await user.click(screen.getByRole("button", { name: "Se connecter" }));
}

describe("Login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Auth configurée et pas encore connecté → on reste sur l'écran de login.
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: false,
      auth_configured: true,
      setup_required: false,
    });
  });

  it("affiche « identifiants incorrects » sur un vrai 401", async () => {
    vi.mocked(Api.login).mockRejectedValue(new ApiError(401, null));
    renderLogin();
    await signIn("admin@exemple.fr", "mauvais");
    expect(await screen.findByText("Identifiants incorrects.")).toBeInTheDocument();
    expect(Api.login).toHaveBeenCalledWith("admin@exemple.fr", "mauvais");
  });

  it("distingue une panne réseau/serveur d'un mot de passe erroné (non-401)", async () => {
    // 503 (backend down) → message dédié, PAS « Identifiants incorrects. ».
    vi.mocked(Api.login).mockRejectedValue(
      new ApiError(503, { detail: { message: "Service indisponible" } }),
    );
    renderLogin();
    await signIn("admin@exemple.fr", "s3cretaire");
    expect(await screen.findByText("Service indisponible")).toBeInTheDocument();
    expect(screen.queryByText("Identifiants incorrects.")).not.toBeInTheDocument();
  });

  it("connecte et redirige vers le dashboard au succès", async () => {
    vi.mocked(Api.login).mockResolvedValue({
      authenticated: true,
      auth_configured: true,
      setup_required: false,
    });
    renderLogin();
    await signIn("admin@exemple.fr", "s3cretaire");
    expect(await screen.findByText("DASHBOARD-OK")).toBeInTheDocument();
  });

  it("redirige d'emblée si le backend autorise déjà (pilote ouvert via dev_open_admin)", async () => {
    // Le backend reflète les règles d'accès dans `authenticated` (dev_open inclus).
    vi.mocked(Api.authStatus).mockResolvedValue({ authenticated: true, auth_configured: false });
    renderLogin();
    await waitFor(() => expect(screen.getByText("DASHBOARD-OK")).toBeInTheDocument());
  });

  it("envoie vers l'installation quand aucun compte administrateur n'existe", async () => {
    // Remplace l'ancien bandeau « définissez ITSM_ADMIN_PASSWORD puis redémarrez » : il n'y
    // a plus rien à faire hors de l'interface.
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: false,
      auth_configured: false,
      setup_required: true,
    });
    renderLogin();
    expect(await screen.findByText("PAGE-INSTALLATION")).toBeInTheDocument();
  });

  it("envoie aussi vers l'installation si le moteur dit juste « auth non configurée »", async () => {
    vi.mocked(Api.authStatus).mockResolvedValue({ authenticated: false, auth_configured: false });
    renderLogin();
    expect(await screen.findByText("PAGE-INSTALLATION")).toBeInTheDocument();
    expect(screen.queryByText(/ITSM_ADMIN_PASSWORD/)).not.toBeInTheDocument();
  });

  it("cesse de proposer l'installation après un 409 (anti-ping-pong /setup ↔ /login)", async () => {
    // Statut périmé : il annonce encore `setup_required` alors que l'écriture a répondu
    // « déjà configuré ». Sans la ceinture, les deux pages se renverraient la balle.
    setupSettled.mark();
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: false,
      auth_configured: false,
      setup_required: true,
    });
    renderLogin();
    expect(await screen.findByRole("heading", { name: "Connexion" })).toBeInTheDocument();
    expect(screen.queryByText("PAGE-INSTALLATION")).not.toBeInTheDocument();
  });

  it("place le focus sur le champ email et annonce le bon autocomplete", async () => {
    renderLogin();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Adresse email")),
    );
    expect(screen.getByLabelText("Mot de passe")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
  });
});
