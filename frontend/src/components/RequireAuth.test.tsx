import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, setupSettled } from "@/lib/api";
import { RequireAuth } from "./RequireAuth";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, authStatus: vi.fn() } };
});

// La garde rend `Layout` quand l'accès est accordé ; on le remplace par un témoin pour
// ne pas embarquer toute la console (topbar, sidebar, une demi-douzaine d'appels API).
vi.mock("@/components/Layout", () => ({ Layout: () => <div>CONSOLE</div> }));

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<RequireAuth />}>
          <Route index element={<div>DASHBOARD-OK</div>} />
        </Route>
        <Route path="/login" element={<div>PAGE-CONNEXION</div>} />
        <Route path="/setup" element={<div>PAGE-INSTALLATION</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireAuth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("laisse passer une session ouverte", async () => {
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: true,
      auth_configured: true,
      setup_required: false,
    });
    renderGuard();
    expect(await screen.findByText("CONSOLE")).toBeInTheDocument();
  });

  it("envoie sur l'installation quand aucun compte n'existe encore", async () => {
    // /login n'offrirait qu'un formulaire que personne ne peut satisfaire.
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: false,
      auth_configured: false,
      setup_required: true,
    });
    renderGuard();
    expect(await screen.findByText("PAGE-INSTALLATION")).toBeInTheDocument();
  });

  it("envoie sur la connexion quand un compte existe mais que la session manque", async () => {
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: false,
      auth_configured: true,
      setup_required: false,
    });
    renderGuard();
    expect(await screen.findByText("PAGE-CONNEXION")).toBeInTheDocument();
  });

  it("envoie sur la connexion si un 409 a déjà démenti le statut dans cet onglet", async () => {
    setupSettled.mark();
    vi.mocked(Api.authStatus).mockResolvedValue({
      authenticated: false,
      auth_configured: false,
      setup_required: true,
    });
    renderGuard();
    expect(await screen.findByText("PAGE-CONNEXION")).toBeInTheDocument();
  });

  it("échoue en fermé : une sonde en erreur renvoie à la connexion", async () => {
    vi.mocked(Api.authStatus).mockRejectedValue(new Error("réseau"));
    renderGuard();
    expect(await screen.findByText("PAGE-CONNEXION")).toBeInTheDocument();
  });
});
