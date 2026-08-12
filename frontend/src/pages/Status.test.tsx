import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type EngineStatus, type PollCycle } from "@/lib/api";
import { demo } from "@/lib/demo";
import { Status } from "./Status";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, status: vi.fn(), health: vi.fn(), getConfig: vi.fn() },
  };
});

/** Statut de démo avec un bloc `last_poll` maîtrisé (le fixture utilise un getter). */
function statusWith(cycle: Partial<PollCycle> | null | undefined): EngineStatus {
  return {
    ...demo.status,
    last_poll:
      cycle == null
        ? cycle
        : {
            // Contrat reel du moteur : le drapeau est toujours present (`LastPoll`).
            has_run: true,
            run_at: new Date().toISOString(),
            fetched: 0,
            processed: 0,
            skipped_done: 0,
            skipped_scope: 0,
            errors: 0,
            error_message: null,
            ...cycle,
          },
  };
}

describe("Status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.status).mockResolvedValue(demo.status);
    vi.mocked(Api.health).mockResolvedValue(demo.health);
    vi.mocked(Api.getConfig).mockResolvedValue(demo.config);
  });

  it("affiche l'état des services (worker, GLPI, liste blanche)", async () => {
    render(<Status />);
    expect(await screen.findByText("En marche")).toBeInTheDocument(); // worker (polling on)
    expect(screen.getByText("Connecté")).toBeInTheDocument(); // GLPI joignable
    // Liste blanche : categories_count / technicians_count
    expect(
      screen.getByText(`${demo.status.categories_count} / ${demo.status.technicians_count}`),
    ).toBeInTheDocument();
  });

  it("affiche les compteurs (appels LLM)", async () => {
    render(<Status />);
    expect(await screen.findByText(/appels LLM au total/)).toBeInTheDocument();
  });

  it("indique le worker en pause si le polling est désactivé", async () => {
    vi.mocked(Api.status).mockResolvedValue({ ...demo.status, polling_enabled: false });
    render(<Status />);
    expect(await screen.findByText("En pause")).toBeInTheDocument();
  });

  describe("dernier cycle de polling", () => {
    it("résume le dernier cycle : âge + compteurs lisibles", async () => {
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ fetched: 12, processed: 3, skipped_done: 9 }),
      );
      render(<Status />);
      expect(await screen.findByText("Dernier cycle de polling")).toBeInTheDocument();
      expect(
        screen.getByText("12 vus, 3 triés, 9 déjà traités, 0 hors périmètre, 0 erreur"),
      ).toBeInTheDocument();
      expect(screen.getByText(/il y a \d+ s|à l'instant/)).toBeInTheDocument();
    });

    it("« aucun cycle exécuté » est visible même quand le worker se dit En marche", async () => {
      vi.mocked(Api.status).mockResolvedValue(statusWith(null));
      render(<Status />);
      expect(await screen.findByText("Aucun cycle exécuté")).toBeInTheDocument();
      // Le méta de la tuile Worker cesse d'annoncer un cycle qui n'a jamais eu lieu.
      expect(screen.getByText("aucun cycle exécuté à ce jour")).toBeInTheDocument();
      expect(screen.getByText(/jamais bouclé une seule fois/)).toBeInTheDocument();
    });

    it("un moteur plus ancien, qui n'expose pas le bloc, affiche « Non mesuré »", async () => {
      vi.mocked(Api.status).mockResolvedValue({
        ...statusWith(undefined),
        version: "0.0.1-ancienne",
      });
      render(<Status />);
      expect(await screen.findByText("Non mesuré")).toBeInTheDocument();
    });

    it("bloc omis par le moteur courant (exclude_none) → « Aucun cycle exécuté »", async () => {
      vi.mocked(Api.status).mockResolvedValue(statusWith(undefined));
      render(<Status />);
      expect(await screen.findByText("Aucun cycle exécuté")).toBeInTheDocument();
    });

    it("un cycle trop ancien est signalé (bien au-delà de l'intervalle)", async () => {
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ run_at: new Date(Date.now() - 40 * 60_000).toISOString(), fetched: 4 }),
      );
      render(<Status />);
      expect(await screen.findByText("cycle trop ancien")).toBeInTheDocument();
      expect(screen.getByText(/n'a pas bouclé depuis bien plus longtemps/)).toBeInTheDocument();
    });

    it("une erreur de cycle affiche le message du moteur", async () => {
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ fetched: 5, errors: 1, error_message: "GLPI 401 : session refusée" }),
      );
      render(<Status />);
      expect(await screen.findByText("GLPI 401 : session refusée")).toBeInTheDocument();
    });

    it("0 ticket lu → piste de diagnostic (périmètre, fenêtre, règle GLPI)", async () => {
      vi.mocked(Api.status).mockResolvedValue(statusWith({ fetched: 0 }));
      render(<Status />);
      expect(await screen.findByText(/Aucun ticket lu dans GLPI/)).toBeInTheDocument();
    });

    it("tout hors périmètre → piste de diagnostic dédiée", async () => {
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ fetched: 7, processed: 0, skipped_scope: 7 }),
      );
      render(<Status />);
      expect(
        await screen.findByText(/hors périmètre : élargissez le périmètre/),
      ).toBeInTheDocument();
    });
  });

  describe("tuile Base de données", () => {
    it("n'affirme plus « Saine » : elle rend compte de la lecture réellement faite", async () => {
      render(<Status />);
      expect(await screen.findByText("Lecture OK")).toBeInTheDocument();
      expect(screen.queryByText("Saine")).not.toBeInTheDocument();
    });

    it("sans compteurs (réponse non enrichie) elle dit « Non mesurée »", async () => {
      vi.mocked(Api.status).mockResolvedValue({
        ok: true,
        version: demo.status.version,
        polling_enabled: true,
      });
      render(<Status />);
      expect(await screen.findByText("Non mesurée")).toBeInTheDocument();
    });
  });

  describe("sonde du fournisseur IA", () => {
    it("aucune sonde au chargement : /health est appelé SANS probe", async () => {
      render(<Status />);
      await screen.findByText("En marche");
      for (const call of vi.mocked(Api.health).mock.calls) {
        expect(call[0]).not.toBe(true);
      }
      expect(screen.getByText("clé enregistrée — validité NON vérifiée")).toBeInTheDocument();
    });

    it("« Tester la connexion » sonde à la demande et affiche le résultat", async () => {
      vi.mocked(Api.health).mockImplementation(async (probe?: boolean) =>
        probe ? demo.healthProbed : demo.health,
      );
      render(<Status />);
      const btn = await screen.findByRole("button", { name: "Tester la connexion" });
      await userEvent.click(btn);
      await waitFor(() => expect(screen.getByText("Joignable")).toBeInTheDocument());
      expect(Api.health).toHaveBeenCalledWith(true);
      expect(screen.getByText("clé validée par un appel réel")).toBeInTheDocument();
    });

    it("une clé refusée par le fournisseur devient visible", async () => {
      vi.mocked(Api.health).mockImplementation(async (probe?: boolean) =>
        probe
          ? { ...demo.health, status: "degraded", llm: { configured: true, reachable: false } }
          : demo.health,
      );
      render(<Status />);
      await userEvent.click(await screen.findByRole("button", { name: "Tester la connexion" }));
      await waitFor(() => expect(screen.getByText("Injoignable")).toBeInTheDocument());
      expect(screen.getByText("la clé est refusée par le fournisseur")).toBeInTheDocument();
    });

    it("un échec réseau du test s'affiche sans casser la page", async () => {
      vi.mocked(Api.health).mockImplementation(async (probe?: boolean) => {
        if (probe) throw new Error("API 503");
        return demo.health;
      });
      render(<Status />);
      await userEvent.click(await screen.findByRole("button", { name: "Tester la connexion" }));
      expect(await screen.findByText(/Échec du test/)).toBeInTheDocument();
    });
  });
});
