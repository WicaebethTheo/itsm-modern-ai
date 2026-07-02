import { Api, ApiError } from "@/lib/api";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
        <Route path="/" element={<div>DASHBOARD-OK</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function passwordInput(): HTMLInputElement {
  const el = document.querySelector('input[type="password"]');
  if (!el) throw new Error("champ mot de passe introuvable");
  return el as HTMLInputElement;
}

describe("Login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Auth configurée et pas encore connecté → on reste sur l'écran de login.
    vi.mocked(Api.authStatus).mockResolvedValue({ authenticated: false, auth_configured: true });
  });

  it("affiche « mot de passe incorrect » sur un vrai 401", async () => {
    vi.mocked(Api.login).mockRejectedValue(new ApiError(401, null));
    renderLogin();
    await userEvent.type(passwordInput(), "mauvais");
    await userEvent.click(screen.getByRole("button", { name: "Se connecter" }));
    expect(await screen.findByText("Mot de passe incorrect.")).toBeInTheDocument();
    expect(Api.login).toHaveBeenCalledWith("mauvais");
  });

  it("distingue une panne réseau/serveur d'un mot de passe erroné (non-401)", async () => {
    // 503 (backend down) → message dédié, PAS « Mot de passe incorrect. ».
    vi.mocked(Api.login).mockRejectedValue(
      new ApiError(503, { detail: { message: "Service indisponible" } }),
    );
    renderLogin();
    await userEvent.type(passwordInput(), "s3cret");
    await userEvent.click(screen.getByRole("button", { name: "Se connecter" }));
    expect(await screen.findByText("Service indisponible")).toBeInTheDocument();
    expect(screen.queryByText("Mot de passe incorrect.")).not.toBeInTheDocument();
  });

  it("connecte et redirige vers le dashboard au succès", async () => {
    vi.mocked(Api.login).mockResolvedValue({ authenticated: true, auth_configured: true });
    renderLogin();
    await userEvent.type(passwordInput(), "s3cret");
    await userEvent.click(screen.getByRole("button", { name: "Se connecter" }));
    expect(await screen.findByText("DASHBOARD-OK")).toBeInTheDocument();
  });

  it("redirige d'emblée si le backend autorise déjà (pilote ouvert via dev_open_admin)", async () => {
    // Le backend reflète les règles d'accès dans `authenticated` (dev_open inclus).
    vi.mocked(Api.authStatus).mockResolvedValue({ authenticated: true, auth_configured: false });
    renderLogin();
    await waitFor(() => expect(screen.getByText("DASHBOARD-OK")).toBeInTheDocument());
  });

  it("reste sur le login avec un bandeau si l'auth n'est pas configurée (fail-closed)", async () => {
    // Repartir vers "/" relançait la boucle 401 → /login → / : on doit rester ici.
    vi.mocked(Api.authStatus).mockResolvedValue({ authenticated: false, auth_configured: false });
    renderLogin();
    expect(
      await screen.findByText(/Aucun mot de passe administrateur configuré/),
    ).toBeInTheDocument();
    expect(screen.queryByText("DASHBOARD-OK")).not.toBeInTheDocument();
  });
});
