import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, type Health, type VersionInfo } from "@/lib/api";
import { renderWithToast } from "@/test-utils";
import { Debug } from "./Debug";

// Seules les méthodes réseau sont remplacées ; le reste du module (ApiError, types) est réel.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      health: vi.fn(),
      version: vi.fn(),
      debugStatus: vi.fn(),
      debugInfo: vi.fn(),
      debugDiagnostics: vi.fn(),
      debugSeed: vi.fn(),
      debugPurgeUsers: vi.fn(),
    },
  };
});

const HEALTH: Health = {
  status: "ok",
  glpi: { configured: true, reachable: true, version: "10.0.12" },
  // `null` = le moteur n'a PAS sondé le fournisseur. Ce n'est pas une panne.
  llm: { configured: true, reachable: null },
};

const VERSION: VersionInfo = {
  current: "9.9.9",
  latest: null,
  update_available: false,
  check_enabled: false,
  latest_notes: null,
  runtime: "docker",
};

/** Presse-papiers : jsdom n'en fournit pas. Renvoie le mock de `writeText`. */
function stubClipboard(impl: (text: string) => Promise<void> = () => Promise.resolve()) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

/** Attend la carte d'état (les deux ressources santé/version sont asynchrones). */
async function stateCard() {
  return await screen.findByRole("heading", { name: "État de l'instance" });
}

describe("Debug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.health).mockResolvedValue(HEALTH);
    vi.mocked(Api.version).mockResolvedValue(VERSION);
    vi.mocked(Api.debugStatus).mockResolvedValue({ enabled: true });
    vi.mocked(Api.debugInfo).mockResolvedValue({
      version: "9.9.9",
      title: "ITSM Modern AI",
      endpoints: [
        { path: "/api/status", methods: ["GET"] },
        { path: "/api/scope", methods: ["GET", "PUT"] },
      ],
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  describe("carte « État de l'instance »", () => {
    it("affiche GLPI joignable avec sa version, et l'IA « non sondé » (pas « en panne »)", async () => {
      renderWithToast(<Debug />);
      await stateCard();
      expect(await screen.findByText("GLPI 10.0.12")).toBeInTheDocument();
      expect(screen.getByText("Joignable")).toBeInTheDocument();
      // Le piège : `reachable === null` ne veut PAS dire injoignable.
      expect(screen.getByText("Non sondé")).toBeInTheDocument();
      expect(screen.queryByText("Injoignable")).not.toBeInTheDocument();
    });

    it("distingue « configuré mais injoignable » de « non configuré »", async () => {
      vi.mocked(Api.health).mockResolvedValue({
        status: "degraded",
        glpi: { configured: true, reachable: false },
        llm: { configured: false, reachable: null },
      });
      renderWithToast(<Debug />);
      await stateCard();
      expect(await screen.findByText("Injoignable")).toBeInTheDocument();
      expect(screen.getByText("Non configuré")).toBeInTheDocument();
    });

    it("annonce le runtime et la version du moteur", async () => {
      renderWithToast(<Debug />);
      await stateCard();
      expect((await screen.findAllByText("v9.9.9")).length).toBeGreaterThan(0);
      expect(screen.getByText(/Exécution : docker/)).toBeInTheDocument();
    });

    it("reste affichée quand les outils de labo sont coupés (le cas normal)", async () => {
      // `/api/debug/status` dit `false` et `/api/debug/info` répond 403 : sans cette carte,
      // la page qu'on ouvre quand « ça ne marche pas » serait vide.
      vi.mocked(Api.debugStatus).mockResolvedValue({ enabled: false });
      vi.mocked(Api.debugInfo).mockRejectedValue(new ApiError(403, null));
      renderWithToast(<Debug />);
      await stateCard();
      expect(await screen.findByText("GLPI 10.0.12")).toBeInTheDocument();
      expect(screen.queryByText("Informations")).not.toBeInTheDocument();
    });

    it("ne promet plus une garantie que le masqueur ne fournit pas", async () => {
      // L'ancienne version de ce test assérait la PRÉSENCE de deux phrases : elle testait
      // la formulation, pas la propriété — et c'est elle qui a laissé passer la garantie
      // absolue « ce rapport ne contient aucun jeton ni clé d'API ». Le masqueur du moteur
      // est ancré sur mots-clés : ce que la page copie vraiment est vérifié plus bas
      // (« recopie tel quel… »), ici on garde seulement la légende honnête.
      renderWithToast(<Debug />);
      await stateCard();
      expect(document.body.textContent).not.toMatch(/ne contient aucun jeton/);
      expect(screen.getByText(/les secrets qu'il RECONNAÎT/)).toBeInTheDocument();
      expect(screen.getByText(/Ce n'est pas une garantie/)).toBeInTheDocument();
      // Les résidus possibles, énumérés : adresses internes ET contenu métier.
      expect(screen.getByText(/adresses internes/)).toBeInTheDocument();
      expect(screen.getByText(/contenu de ticket et des noms de personnes/)).toBeInTheDocument();
    });

    it("n'affirme rien quand la santé est indisponible", async () => {
      vi.mocked(Api.health).mockRejectedValue(new Error("réseau"));
      renderWithToast(<Debug />);
      await stateCard();
      expect(await screen.findByText(/Santé indisponible/)).toBeInTheDocument();
      expect(screen.getAllByText("Inconnu").length).toBeGreaterThan(0);
    });
  });

  describe("bannière « outils désactivés »", () => {
    it("dit où poser la variable, qu'il faut relancer, et vouvoie", async () => {
      vi.mocked(Api.debugStatus).mockResolvedValue({ enabled: false });
      vi.mocked(Api.debugInfo).mockRejectedValue(new ApiError(403, null));
      renderWithToast(<Debug />);
      expect(await screen.findByText("DEBUG_TOOLS_ENABLED=true")).toBeInTheDocument();
      expect(screen.getByText(/fichier \.env du déploiement/)).toBeInTheDocument();
      expect(screen.getByText(/relancez le conteneur/)).toBeInTheDocument();
      // Le tutoiement (« Active DEBUG_TOOLS_ENABLED… ») était le seul de toute la console.
      expect(document.body.textContent).not.toMatch(/\bActive\b/);
    });

    it("ne se montre pas quand l'état des outils n'a pas pu être lu (≠ désactivé)", async () => {
      vi.mocked(Api.debugStatus).mockRejectedValue(new Error("502"));
      vi.mocked(Api.debugInfo).mockRejectedValue(new ApiError(403, null));
      renderWithToast(<Debug />);
      expect(await screen.findByText(/État des outils indisponible/)).toBeInTheDocument();
      expect(screen.queryByText("DEBUG_TOOLS_ENABLED=true")).not.toBeInTheDocument();
    });
  });

  describe("copie du rapport", () => {
    it("copie un rapport lisible et confirme", async () => {
      // `userEvent.setup()` pose SON propre stub de presse-papiers : le nôtre doit
      // passer après, sinon il est écrasé et l'assertion porte sur le mauvais mock.
      const user = userEvent.setup();
      const writeText = stubClipboard();
      renderWithToast(<Debug />);
      await stateCard();
      await screen.findByText("GLPI 10.0.12");
      await user.click(screen.getByRole("button", { name: "Copier le rapport" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const report = writeText.mock.calls[0][0] as string;
      expect(report).toContain("Version : 9.9.9");
      expect(report).toContain("Exécution : docker");
      expect(report).toContain("GLPI : Joignable");
      expect(report).toContain("Non sondé");
      expect(report).toContain("Diagnostic détaillé : non lancé");
      expect(await screen.findByText("Rapport copié.")).toBeInTheDocument();
    });

    it("propose la copie manuelle quand le presse-papiers refuse", async () => {
      const user = userEvent.setup();
      stubClipboard(() => Promise.reject(new Error("refusé")));
      renderWithToast(<Debug />);
      await stateCard();
      await user.click(screen.getByRole("button", { name: "Copier le rapport" }));
      expect(
        await screen.findByText("Copie impossible — copiez manuellement."),
      ).toBeInTheDocument();
    });

    it("recopie tel quel ce que le moteur a renvoyé — secret non reconnu compris", async () => {
      // LA propriété, mesurée sur le presse-papiers et non sur une phrase : le rapport
      // n'est pas re-masqué côté interface. Le masqueur du moteur est ancré sur mots-clés
      // (`token`, `api_key`, `password`…) plus deux préfixes de clés cloud ; une clé posée
      // seule dans un corps d'erreur, sans mot-clé devant, arrive donc en clair — tout
      // comme un titre de ticket et le nom de son demandeur. Tant que c'est vrai, la
      // légende de la page ne doit promettre AUCUNE garantie absolue.
      const FAUSSE_CLE = "sk-proj-FAUSSE-CLE-DE-TEST-0000";
      vi.mocked(Api.debugDiagnostics).mockResolvedValue({
        glpi: {
          configured: true,
          reachable: false,
          error: `500 sur /Ticket : « Imprimante HS — Jean Dupont » (${FAUSSE_CLE})`,
        },
        llm: { configured: true, reachable: false },
      });
      // `userEvent.setup()` pose SON propre stub de presse-papiers : le nôtre doit passer
      // après, sinon il est écrasé en silence et l'assertion porte sur le mauvais mock.
      const user = userEvent.setup();
      const writeText = stubClipboard();
      renderWithToast(<Debug />);
      await stateCard();
      await user.click(await screen.findByRole("button", { name: "Lancer le diagnostic" }));
      await screen.findByText("Résultat du diagnostic");
      await user.click(screen.getByRole("button", { name: "Copier le rapport" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      const report = writeText.mock.calls[0][0] as string;
      expect(report).toContain(FAUSSE_CLE); // la clé N'EST PAS masquée : il faut le dire
      expect(report).toContain("Jean Dupont"); // le contenu de ticket non plus
    });

    it("embarque le diagnostic détaillé une fois celui-ci lancé", async () => {
      vi.mocked(Api.debugDiagnostics).mockResolvedValue({
        glpi: { configured: true, reachable: true, new_tickets: 4 },
        llm: { configured: true, reachable: true },
      });
      const user = userEvent.setup();
      const writeText = stubClipboard();
      renderWithToast(<Debug />);
      await stateCard();
      await user.click(await screen.findByRole("button", { name: "Lancer le diagnostic" }));
      await screen.findByText("Résultat du diagnostic");
      await user.click(screen.getByRole("button", { name: "Copier le rapport" }));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      expect(writeText.mock.calls[0][0] as string).toContain('"new_tickets": 4');
    });
  });

  describe("diagnostics", () => {
    it("donne un vrai libellé au bouton pendant l'exécution", async () => {
      let release: (v: never) => void = () => undefined;
      vi.mocked(Api.debugDiagnostics).mockReturnValue(
        new Promise((r) => {
          release = r as (v: never) => void;
        }),
      );
      const user = userEvent.setup();
      renderWithToast(<Debug />);
      await user.click(await screen.findByRole("button", { name: "Lancer le diagnostic" }));
      // Le libellé « … » n'annonçait rien du tout à un lecteur d'écran.
      expect(screen.getByRole("button", { name: "Diagnostic en cours…" })).toBeDisabled();
      release({ glpi: { configured: true }, llm: { configured: true } } as never);
      expect(await screen.findByText("Résultat du diagnostic")).toBeInTheDocument();
    });

    it("annonce le résultat dans une région live qui préexiste à celui-ci", async () => {
      vi.mocked(Api.debugDiagnostics).mockResolvedValue({
        glpi: { configured: true, reachable: true },
        llm: { configured: true, reachable: true },
      });
      const user = userEvent.setup();
      const { container } = renderWithToast(<Debug />);
      const regions = container.querySelectorAll('[aria-live="polite"]');
      expect(regions.length).toBeGreaterThanOrEqual(3); // diag + seed + purge
      await user.click(await screen.findByRole("button", { name: "Lancer le diagnostic" }));
      const result = await screen.findByText("Résultat du diagnostic");
      expect(result.closest('[aria-live="polite"]')).not.toBeNull();
    });

    it("remonte l'erreur du moteur sans prétendre à un résultat", async () => {
      vi.mocked(Api.debugDiagnostics).mockRejectedValue(
        new ApiError(500, { detail: { message: "Connecteur en vrac" } }),
      );
      const user = userEvent.setup();
      renderWithToast(<Debug />);
      await user.click(await screen.findByRole("button", { name: "Lancer le diagnostic" }));
      expect(await screen.findByText("Connecteur en vrac")).toBeInTheDocument();
      expect(screen.queryByText("Résultat du diagnostic")).not.toBeInTheDocument();
    });
  });

  describe("outils qui écrivent dans GLPI", () => {
    it("sépare la lecture de l'écriture par deux intertitres", async () => {
      renderWithToast(<Debug />);
      expect(await screen.findByRole("heading", { name: "Lecture seule" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Écrit dans votre GLPI/ })).toBeInTheDocument();
    });

    it("borne la saisie numérique : un champ vidé vaut 0, jamais NaN", async () => {
      vi.mocked(Api.debugSeed).mockResolvedValue({ users: [], groups: [] });
      const user = userEvent.setup();
      renderWithToast(<Debug />);
      const techs = await screen.findByLabelText("Techniciens");
      await user.clear(techs);
      expect(techs).toHaveValue(0);
      await user.click(screen.getByRole("button", { name: "Créer les faux comptes" }));
      await waitFor(() => expect(Api.debugSeed).toHaveBeenCalledWith(0, 2));
      // `Number("")` valait NaN, sérialisé en `null` puis refusé par le moteur.
      expect(vi.mocked(Api.debugSeed).mock.calls[0].every(Number.isFinite)).toBe(true);
    });

    it("plafonne la saisie au maximum accepté par le moteur", async () => {
      const user = userEvent.setup();
      renderWithToast(<Debug />);
      const groups = await screen.findByLabelText("Groupes");
      await user.clear(groups);
      await user.type(groups, "999");
      expect(groups).toHaveValue(50);
    });

    it("garde la purge derrière la saisie de confirmation", async () => {
      const user = userEvent.setup();
      renderWithToast(<Debug />);
      const purge = await screen.findByRole("button", { name: /Purger les utilisateurs/ });
      expect(purge).toBeDisabled();
      await user.type(screen.getByLabelText("Confirmation"), "SUPPRIMER");
      expect(purge).toBeEnabled();
    });

    it("désactive tous les outils quand le réglage est faux", async () => {
      vi.mocked(Api.debugStatus).mockResolvedValue({ enabled: false });
      vi.mocked(Api.debugInfo).mockRejectedValue(new ApiError(403, null));
      renderWithToast(<Debug />);
      expect(await screen.findByRole("button", { name: "Lancer le diagnostic" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Créer les faux comptes" })).toBeDisabled();
    });
  });

  it("replie la liste des routes exposées", async () => {
    renderWithToast(<Debug />);
    const summary = await screen.findByText(/Routes exposées/);
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(within(details as HTMLElement).getByText("/api/scope")).toBeInTheDocument();
  });
});
