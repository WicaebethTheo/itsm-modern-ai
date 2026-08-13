import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, type AuthStatus, setupSettled } from "@/lib/api";
import { Login } from "./Login";
import { Setup } from "./Setup";

// On mocke le module Api : on garde les exports réels (asBool, types…) et on
// remplace seulement les méthodes réseau utilisées par Login.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, authStatus: vi.fn(), login: vi.fn() },
  };
});

/**
 * Les DEUX vraies pages dans le même routeur — pas de doublure pour `/setup`.
 *
 * C'est la seule façon de mesurer le défaut : une doublure ne renvoie jamais la balle, donc
 * elle ne peut pas boucler. Ici, `/login` et `/setup` s'appellent réellement l'une l'autre.
 */
function renderPair() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/" element={<div>DASHBOARD-OK</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Sonde d'état instrumentée : elle COMPTE les appels et coupe le courant au-delà de
 * `MAX_PROBES`. Sans ce coupe-circuit, une régression ne ferait pas échouer le test — elle
 * ferait tourner la boucle jusqu'au délai d'expiration, en noyant la sortie. Avec lui,
 * l'assertion porte sur un nombre.
 */
const MAX_PROBES = 20;

function countingStatus(answer: (call: number) => AuthStatus) {
  const calls = { n: 0 };
  vi.mocked(Api.authStatus).mockImplementation(() => {
    calls.n += 1;
    if (calls.n > MAX_PROBES) return Promise.reject(new Error("coupe-circuit du test"));
    return Promise.resolve(answer(calls.n));
  });
  return calls;
}

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
    // Les ceintures anti-boucle vivent en sessionStorage (portée : l'onglet) : sans ce
    // nettoyage, un test en marquerait une pour les suivants.
    sessionStorage.clear();
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

  it("ne renvoie pas la balle à /setup quand le moteur ne dit QUE « auth non configurée »", async () => {
    // LE défaut mesuré : `/login` renvoyait vers `/setup` sur `!auth_configured`, mais
    // `/setup` n'affichait son formulaire que sur `setup_required` — absent ici (le cas
    // « moteur antérieur » de lib/api.ts). Les deux pages se renvoyaient la balle : 88
    // appels à /api/auth/status en 300 ms. Les deux lisent désormais le MÊME prédicat.
    const calls = countingStatus(() => ({ authenticated: false, auth_configured: false }));
    renderPair();
    // On s'arrête sur le formulaire d'installation, et on ne repart pas.
    expect(
      await screen.findByRole("heading", { name: "Bienvenue. Créons votre compte." }),
    ).toBeInTheDocument();
    expect(calls.n).toBeLessThanOrEqual(2); // un appel par page, une seule fois chacune
  });

  it("coupe le ping-pong même si le moteur se contredit d'un appel à l'autre", async () => {
    // La ceinture, pour ce que le prédicat partagé ne peut pas couvrir : un statut en
    // cache, un second onglet, une réplique en retard. Appels impairs (/login) : « il faut
    // installer » ; appels pairs (/setup) : « c'est déjà fait ». Sans budget, ces deux
    // réponses bouclent à l'infini.
    const calls = countingStatus((n) =>
      n % 2 === 1
        ? { authenticated: false, auth_configured: false, setup_required: true }
        : { authenticated: false, auth_configured: true, setup_required: false },
    );
    renderPair();
    // On attend que les allers-retours CESSENT avant d'interroger l'écran : pendant la
    // bascule, /login et /setup se remplacent d'un microtask à l'autre, et une requête
    // lancée au milieu observe un état transitoire qui ne dit rien du résultat.
    await waitFor(() => expect(screen.queryByText(/Vérification de l'installation/)).toBeNull());
    // On finit sur l'écran de connexion : le seul qui porte la commande de récupération.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Connexion" })).toBeInTheDocument(),
    );
    expect(calls.n).toBeLessThan(MAX_PROBES);
  });

  it("verrouille l'envoi et décompte l'attente sur un 429", async () => {
    // Le moteur renvoie Retry-After ; sans décompte, le bouton reste actif et l'admin
    // martèle — chaque coup rallonge le blocage.
    vi.mocked(Api.login).mockRejectedValue(
      new ApiError(
        429,
        { detail: { code: "too_many_attempts", message: "Trop de tentatives." } },
        45,
      ),
    );
    renderLogin();
    await signIn("admin@exemple.fr", "mauvais");
    expect(await screen.findByText(/Réessayez dans 45 secondes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Réessayez dans 45 s/ })).toBeDisabled();
  });

  it("n'invente aucun délai quand le 429 arrive sans Retry-After", async () => {
    // Un limiteur intermédiaire (nginx, Traefik, WAF) refuse sans l'en-tête. Une minute
    // inventée verrouillerait le bouton sur un chiffre que personne n'a mesuré.
    vi.mocked(Api.login).mockRejectedValue(
      new ApiError(429, { detail: { code: "too_many_attempts", message: "Trop de tentatives." } }),
    );
    renderLogin();
    await signIn("admin@exemple.fr", "mauvais");
    expect(await screen.findByText("Trop de tentatives.")).toBeInTheDocument();
    expect(screen.queryByText(/Réessayez dans/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Se connecter" })).toBeEnabled();
  });

  it("n'envoie rien au moteur quand l'email est vide (une tentative brûlée pour rien)", async () => {
    renderLogin();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Mot de passe"), "s3cretaire");
    await user.click(screen.getByRole("button", { name: "Se connecter" }));
    expect(await screen.findByText("Renseignez votre adresse email.")).toBeInTheDocument();
    expect(Api.login).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("Adresse email"));
  });

  it("n'envoie rien non plus quand le mot de passe est vide, et vise le bon champ", async () => {
    renderLogin();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Adresse email"), "admin@exemple.fr");
    await user.click(screen.getByRole("button", { name: "Se connecter" }));
    expect(await screen.findByText("Renseignez votre mot de passe.")).toBeInTheDocument();
    expect(Api.login).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("Mot de passe"));
  });

  it("ne dit toujours RIEN de plus sur un 401 : email inconnu et mot de passe faux se confondent", async () => {
    // La garde locale ci-dessus ne porte que sur les champs VIDES. Elle ne doit pas
    // réintroduire côté client la distinction que le backend paie pour ne pas faire.
    vi.mocked(Api.login).mockRejectedValue(new ApiError(401, null));
    renderLogin();
    await signIn("inconnu@exemple.fr", "peu-importe");
    const first = await screen.findByText("Identifiants incorrects.");
    expect(first).toBeInTheDocument();
    expect(screen.queryByText(/inconnu|introuvable|n'existe pas/i)).not.toBeInTheDocument();
  });

  it("donne le SEUL chemin de récupération, replié par défaut", async () => {
    renderLogin();
    const summary = await screen.findByText("Mot de passe oublié ?");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(
      screen.getByText("docker compose exec itsm python -m itsm_modern_ai.admin_setup --force"),
    ).toBeInTheDocument();
    expect(screen.getByText(/pas de réinitialisation par email/)).toBeInTheDocument();
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
