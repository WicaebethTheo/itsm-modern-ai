import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type EngineStatus, type Health, type PollCycle } from "@/lib/api";
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

  it("affiche l'état des services (boucle de polling, GLPI, liste blanche)", async () => {
    render(<Status />);
    expect(await screen.findByText("En marche")).toBeInTheDocument(); // polling activé
    expect(screen.getByText("Connecté")).toBeInTheDocument(); // GLPI joignable
    // Liste blanche : un compte par ligne — « 7 / 4 » se lisait « 7 sur 4 ».
    expect(screen.getByText(`${demo.status.categories_count} catégories`)).toBeInTheDocument();
    expect(
      screen.getByText(`${demo.status.technicians_count} techniciens dans le périmètre`),
    ).toBeInTheDocument();
  });

  it("affiche la version de GLPI remontée par /health (diagnostic gratuit)", async () => {
    render(<Status />);
    expect(await screen.findByText(/GLPI 10\.0\.18 ·/)).toBeInTheDocument();
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

  describe("verdict d'ensemble", () => {
    it("tout va bien → le verdict l'annonce en une phrase", async () => {
      render(<Status />);
      expect(await screen.findByText("Le moteur trie les tickets")).toBeInTheDocument();
    });

    it("un cycle en erreur prime sur tout le reste", async () => {
      vi.mocked(Api.status).mockResolvedValue(statusWith({ fetched: 5, errors: 2 }));
      render(<Status />);
      expect(await screen.findByText("Le moteur ne trie plus")).toBeInTheDocument();
    });

    it("polling coupé → « Triage en pause » (sans réutiliser le libellé de la tuile)", async () => {
      vi.mocked(Api.status).mockResolvedValue({ ...demo.status, polling_enabled: false });
      render(<Status />);
      expect(await screen.findByText("Triage en pause")).toBeInTheDocument();
    });

    it("GLPI injoignable → le verdict dit que rien ne peut être trié", async () => {
      vi.mocked(Api.health).mockResolvedValue({
        ...demo.health,
        status: "degraded",
        glpi: { configured: true, reachable: false },
      });
      render(<Status />);
      expect(
        await screen.findByText("GLPI est injoignable — rien ne peut être trié"),
      ).toBeInTheDocument();
    });

    it("API muette → verdict neutre, aucune affirmation", async () => {
      vi.mocked(Api.status).mockRejectedValue(new Error("API 503"));
      render(<Status />);
      expect(await screen.findByText("Statut du moteur inconnu")).toBeInTheDocument();
      expect(screen.queryByText("En pause")).not.toBeInTheDocument();
      expect(screen.getAllByText("Inconnu").length).toBeGreaterThan(0);
      expect(screen.getAllByText("l'API n'a pas répondu").length).toBeGreaterThan(0);
    });
  });

  describe("chargement", () => {
    it("pendant le chargement, la page n'affirme ni « En pause » ni « Non configuré »", async () => {
      vi.mocked(Api.status).mockReturnValue(new Promise<EngineStatus>(() => {}));
      vi.mocked(Api.health).mockReturnValue(new Promise<Health>(() => {}));
      render(<Status />);
      expect(await screen.findByText("Statut du moteur inconnu")).toBeInTheDocument();
      expect(screen.queryByText("En pause")).not.toBeInTheDocument();
      expect(screen.queryByText("Non configuré")).not.toBeInTheDocument();
      expect(screen.queryByText("Non mesurée")).not.toBeInTheDocument();
      expect(screen.queryByText("Aucun cycle exécuté")).not.toBeInTheDocument();
    });
  });

  describe("dernier cycle de polling", () => {
    it("has_run: false (le moteur sérialise TOUJOURS le bloc) → aucun cycle exécuté", async () => {
      vi.mocked(Api.status).mockResolvedValue(statusWith({ has_run: false }));
      render(<Status />);
      expect(await screen.findByText("Aucun cycle exécuté")).toBeInTheDocument();
      expect(screen.getByText("Le moteur n'a jamais trié")).toBeInTheDocument();
      expect(screen.getByText("aucun cycle exécuté à ce jour")).toBeInTheDocument();
    });

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

  describe("horloge d'affichage et rafraîchissement", () => {
    it("l'âge du cycle vieillit tout seul : « cycle trop ancien » finit par apparaître", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(Api.status).mockResolvedValue(statusWith({ fetched: 4 }));
        render(<Status />);
        await act(async () => {}); // laisse résoudre les chargements initiaux
        expect(screen.queryByText("cycle trop ancien")).not.toBeInTheDocument();
        await act(async () => {
          vi.advanceTimersByTime(20 * 60_000);
        });
        expect(screen.getByText("cycle trop ancien")).toBeInTheDocument();
        expect(screen.getByText("Le moteur est peut-être arrêté")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("le rafraîchissement automatique ne touche QUE /api/status (jamais /health → GLPI)", async () => {
      vi.useFakeTimers();
      try {
        render(<Status />);
        await act(async () => {});
        const healthCalls = vi.mocked(Api.health).mock.calls.length;
        await act(async () => {
          vi.advanceTimersByTime(5 * 60_000);
        });
        expect(vi.mocked(Api.status).mock.calls.length).toBeGreaterThan(1);
        expect(vi.mocked(Api.health).mock.calls.length).toBe(healthCalls);
      } finally {
        vi.useRealTimers();
      }
    });

    it("« Tout réactualiser » relance explicitement /health", async () => {
      render(<Status />);
      const btn = await screen.findByRole("button", { name: "Tout réactualiser" });
      const before = vi.mocked(Api.health).mock.calls.length;
      await userEvent.click(btn);
      await waitFor(() => expect(vi.mocked(Api.health).mock.calls.length).toBeGreaterThan(before));
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

  describe("tuile Plafond de coût", () => {
    it("formate les montants à 2 décimales", async () => {
      render(<Status />);
      expect(await screen.findByText("1,83 € / 5,00 €")).toBeInTheDocument();
    });

    it("un plafond à 0 signifie AUCUN plafond, pas un budget nul", async () => {
      vi.mocked(Api.status).mockResolvedValue({ ...demo.status, cost_cap_eur_per_day: 0 });
      render(<Status />);
      expect(await screen.findByText(/aucun plafond/)).toBeInTheDocument();
      expect(screen.queryByText(/\/ 0,00 €/)).not.toBeInTheDocument();
    });

    it("plafond atteint : le triage s'arrête, la tuile le dit", async () => {
      vi.mocked(Api.status).mockResolvedValue({
        ...demo.status,
        cost_eur_last_24h: 5.4,
        cost_cap_eur_per_day: 5,
      });
      render(<Status />);
      expect(
        await screen.findByText("plafond atteint : les appels LLM facturables sont coupés"),
      ).toBeInTheDocument();
      expect(screen.getByText(/partent « à trier » jusqu'à la reprise/)).toBeInTheDocument();
    });
  });

  describe("tuile Liste blanche", () => {
    it("liste blanche non chargée : aucun compte n'est affiché", async () => {
      vi.mocked(Api.status).mockResolvedValue({ ...demo.status, whitelist_loaded: false });
      render(<Status />);
      expect(await screen.findByText("Non chargée")).toBeInTheDocument();
      expect(screen.queryByText("7 catégories")).not.toBeInTheDocument();
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
