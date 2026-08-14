import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Api,
  type EngineStatus,
  type Health,
  type LlmTestResult,
  type PollCycle,
  type PollRunResult,
} from "@/lib/api";
import { demo } from "@/lib/demo";
import { Status } from "./Status";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: {
      ...actual.Api,
      status: vi.fn(),
      health: vi.fn(),
      getConfig: vi.fn(),
      testLlm: vi.fn(),
      runPoll: vi.fn(),
    },
  };
});

/**
 * La page porte des liens de remède (réactiver l'ingestion, configurer GLPI) : sans
 * routeur, leur seul rendu ferait tomber le test sur une erreur sans rapport avec le sujet.
 */
function renderStatus() {
  return render(
    <MemoryRouter>
      <Status />
    </MemoryRouter>,
  );
}

/** Verdict de test LLM par défaut (succès), surchargeable champ par champ. */
function llmTest(over: Partial<LlmTestResult> = {}): LlmTestResult {
  return {
    ok: true,
    stage: "ok",
    provider: "mistral",
    model: "mistral-large-latest",
    latency_ms: 940,
    prompt_tokens: 268,
    completion_tokens: 96,
    cost_eur: 0.0011,
    category: 1,
    priority: 3,
    confidence: 0.82,
    error: null,
    ...over,
  };
}

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
    renderStatus();
    expect(await screen.findByText("En marche")).toBeInTheDocument(); // polling activé
    expect(screen.getByText("Connecté")).toBeInTheDocument(); // GLPI joignable
    // Liste blanche : un compte par ligne — « 7 / 4 » se lisait « 7 sur 4 ».
    expect(screen.getByText(`${demo.status.categories_count} catégories`)).toBeInTheDocument();
    expect(
      screen.getByText(`${demo.status.technicians_count} techniciens dans le périmètre`),
    ).toBeInTheDocument();
  });

  it("affiche la version de GLPI remontée par /health (diagnostic gratuit)", async () => {
    renderStatus();
    expect(await screen.findByText(/GLPI 10\.0\.18 ·/)).toBeInTheDocument();
  });

  it("affiche les compteurs (appels LLM)", async () => {
    renderStatus();
    expect(await screen.findByText(/appels LLM au total/)).toBeInTheDocument();
  });

  it("indique le worker en pause si le polling est désactivé", async () => {
    vi.mocked(Api.status).mockResolvedValue({ ...demo.status, polling_enabled: false });
    renderStatus();
    expect(await screen.findByText("En pause")).toBeInTheDocument();
  });

  describe("verdict d'ensemble", () => {
    it("tout va bien → le verdict l'annonce en une phrase", async () => {
      renderStatus();
      expect(await screen.findByText("Le moteur trie les tickets")).toBeInTheDocument();
    });

    it("un cycle qui n'a RIEN trié malgré ses erreurs → le moteur ne trie plus", async () => {
      vi.mocked(Api.status).mockResolvedValue(statusWith({ fetched: 5, processed: 0, errors: 5 }));
      renderStatus();
      expect(await screen.findByText("Le moteur ne trie plus")).toBeInTheDocument();
    });

    it("des erreurs PARTIELLES ne font pas dire « le moteur ne trie plus »", async () => {
      // Le compteur `errors` du poller est incrémenté PAR TICKET : 1 échec sur 100 ne
      // dit rien de la santé du moteur — il a trié les 99 autres.
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ fetched: 100, processed: 99, errors: 1 }),
      );
      renderStatus();
      expect(
        await screen.findByText("Des tickets sont partis « à trier » sur erreur"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Le moteur ne trie plus")).not.toBeInTheDocument();
      // Le compte réel, deux fois : dans le verdict et dans la carte du dernier cycle.
      expect(screen.getAllByText(/1 ticket en échec sur 100/).length).toBeGreaterThan(1);
    });

    it("aucun fournisseur IA configuré → le verdict le dit avant de conclure au vert", async () => {
      vi.mocked(Api.health).mockResolvedValue({
        ...demo.health,
        llm: { configured: false, reachable: null },
      });
      renderStatus();
      expect(await screen.findByText("Aucun fournisseur IA n'est configuré")).toBeInTheDocument();
      expect(screen.queryByText("Le moteur trie les tickets")).not.toBeInTheDocument();
    });

    it("polling en pause ET aucun cycle : c'est attendu, pas une panne", async () => {
      vi.mocked(Api.status).mockResolvedValue({
        ...statusWith({ has_run: false }),
        polling_enabled: false,
      });
      renderStatus();
      expect(await screen.findByText("Triage en pause")).toBeInTheDocument();
      expect(screen.queryByText("Le moteur n'a jamais trié")).not.toBeInTheDocument();
    });

    it("installation neuve (GLPI non configuré) → verdict de mise en service, pas d'alarme", async () => {
      vi.mocked(Api.health).mockResolvedValue({
        ...demo.health,
        status: "degraded",
        glpi: { configured: false, reachable: false },
      });
      vi.mocked(Api.status).mockResolvedValue(statusWith(null)); // aucun cycle : le cycle
      renderStatus(); // sort avant de persister ses compteurs
      expect(await screen.findByText("GLPI n'est pas encore configuré")).toBeInTheDocument();
      expect(screen.queryByText("Le moteur n'a jamais trié")).not.toBeInTheDocument();
      // Aucune connexion n'a jamais été TENTÉE : le titre ne peut pas parler d'échec.
      expect(
        screen.queryByText("GLPI est injoignable — rien ne peut être trié"),
      ).not.toBeInTheDocument();
    });

    it("un moteur muet sur son cycle : le verdict ne prétend pas que l'API n'a pas répondu", async () => {
      vi.mocked(Api.status).mockResolvedValue({
        ...statusWith(undefined),
        version: "0.0.1-ancienne",
      });
      renderStatus();
      expect(await screen.findByText("Statut du moteur inconnu")).toBeInTheDocument();
      expect(screen.getByText(/ni confirmer ni infirmer/)).toBeInTheDocument();
      expect(screen.queryByText(/tant que l'API n'a pas répondu/)).not.toBeInTheDocument();
    });

    it("sans horodatage, aucun verdict nominal : la fraîcheur n'a pas été mesurée", async () => {
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ run_at: null, fetched: 4, processed: 4 }),
      );
      renderStatus();
      expect(await screen.findByText("Fraîcheur du dernier cycle inconnue")).toBeInTheDocument();
      expect(screen.queryByText("Le moteur trie les tickets")).not.toBeInTheDocument();
    });

    it("polling coupé → « Triage en pause » (sans réutiliser le libellé de la tuile)", async () => {
      vi.mocked(Api.status).mockResolvedValue({ ...demo.status, polling_enabled: false });
      renderStatus();
      expect(await screen.findByText("Triage en pause")).toBeInTheDocument();
    });

    it("GLPI injoignable → le verdict dit que rien ne peut être trié", async () => {
      vi.mocked(Api.health).mockResolvedValue({
        ...demo.health,
        status: "degraded",
        glpi: { configured: true, reachable: false },
      });
      renderStatus();
      expect(
        await screen.findByText("GLPI est injoignable — rien ne peut être trié"),
      ).toBeInTheDocument();
    });

    it("API muette → verdict neutre, aucune affirmation", async () => {
      vi.mocked(Api.status).mockRejectedValue(new Error("API 503"));
      renderStatus();
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
      renderStatus();
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
      renderStatus();
      expect(await screen.findByText("Aucun cycle exécuté")).toBeInTheDocument();
      expect(screen.getByText("Le moteur n'a jamais trié")).toBeInTheDocument();
      expect(screen.getByText("aucun cycle exécuté à ce jour")).toBeInTheDocument();
    });

    it("résume le dernier cycle : âge + compteurs lisibles", async () => {
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ fetched: 12, processed: 3, skipped_done: 9 }),
      );
      renderStatus();
      expect(await screen.findByText("Dernier cycle de polling")).toBeInTheDocument();
      expect(
        screen.getByText("12 vus, 3 triés, 9 déjà traités, 0 hors périmètre, 0 erreur"),
      ).toBeInTheDocument();
      expect(screen.getByText(/il y a \d+ s|à l'instant/)).toBeInTheDocument();
    });

    it("« aucun cycle exécuté » est visible même quand le worker se dit En marche", async () => {
      vi.mocked(Api.status).mockResolvedValue(statusWith(null));
      renderStatus();
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
      renderStatus();
      expect(await screen.findByText("Non mesuré")).toBeInTheDocument();
    });

    it("bloc omis par le moteur courant (exclude_none) → « Aucun cycle exécuté »", async () => {
      vi.mocked(Api.status).mockResolvedValue(statusWith(undefined));
      renderStatus();
      expect(await screen.findByText("Aucun cycle exécuté")).toBeInTheDocument();
    });

    it("un cycle trop ancien est signalé (bien au-delà de l'intervalle)", async () => {
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ run_at: new Date(Date.now() - 40 * 60_000).toISOString(), fetched: 4 }),
      );
      renderStatus();
      expect(await screen.findByText("cycle trop ancien")).toBeInTheDocument();
      expect(screen.getByText(/n'a pas bouclé depuis bien plus longtemps/)).toBeInTheDocument();
    });

    it("une erreur de cycle affiche le message du moteur", async () => {
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ fetched: 5, errors: 1, error_message: "GLPI 401 : session refusée" }),
      );
      renderStatus();
      expect(await screen.findByText("GLPI 401 : session refusée")).toBeInTheDocument();
    });

    it("0 ticket lu → piste de diagnostic (périmètre, fenêtre, règle GLPI)", async () => {
      vi.mocked(Api.status).mockResolvedValue(statusWith({ fetched: 0 }));
      renderStatus();
      expect(await screen.findByText(/Aucun ticket lu dans GLPI/)).toBeInTheDocument();
    });

    it("tout hors périmètre → piste de diagnostic dédiée", async () => {
      vi.mocked(Api.status).mockResolvedValue(
        statusWith({ fetched: 7, processed: 0, skipped_scope: 7 }),
      );
      renderStatus();
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
        renderStatus();
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
        renderStatus();
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
      renderStatus();
      const btn = await screen.findByRole("button", { name: "Tout réactualiser" });
      const before = vi.mocked(Api.health).mock.calls.length;
      await userEvent.click(btn);
      await waitFor(() => expect(vi.mocked(Api.health).mock.calls.length).toBeGreaterThan(before));
    });
  });

  describe("tuile Base de données", () => {
    it("n'affirme plus « Saine » : elle rend compte de la lecture réellement faite", async () => {
      renderStatus();
      expect(await screen.findByText("Lecture OK")).toBeInTheDocument();
      expect(screen.queryByText("Saine")).not.toBeInTheDocument();
    });

    it("sans compteurs (réponse non enrichie) elle dit « Non mesurée »", async () => {
      vi.mocked(Api.status).mockResolvedValue({
        ok: true,
        version: demo.status.version,
        polling_enabled: true,
      });
      renderStatus();
      expect(await screen.findByText("Non mesurée")).toBeInTheDocument();
    });
  });

  describe("tuile Plafond de coût", () => {
    it("formate les montants à 2 décimales", async () => {
      renderStatus();
      expect(await screen.findByText("1,83 € / 5,00 €")).toBeInTheDocument();
    });

    it("un plafond à 0 signifie AUCUN plafond, pas un budget nul", async () => {
      vi.mocked(Api.status).mockResolvedValue({ ...demo.status, cost_cap_eur_per_day: 0 });
      renderStatus();
      expect(await screen.findByText(/aucun plafond/)).toBeInTheDocument();
      expect(screen.queryByText(/\/ 0,00 €/)).not.toBeInTheDocument();
    });

    it("plafond atteint : le triage s'arrête, la tuile le dit", async () => {
      vi.mocked(Api.status).mockResolvedValue({
        ...demo.status,
        cost_eur_last_24h: 5.4,
        cost_cap_eur_per_day: 5,
      });
      renderStatus();
      expect(
        await screen.findByText("plafond atteint : les appels LLM facturables sont coupés"),
      ).toBeInTheDocument();
      expect(screen.getByText(/partent « à trier » jusqu'à la reprise/)).toBeInTheDocument();
    });
  });

  describe("tuile Liste blanche", () => {
    it("liste blanche non chargée : aucun compte n'est affiché", async () => {
      vi.mocked(Api.status).mockResolvedValue({ ...demo.status, whitelist_loaded: false });
      renderStatus();
      expect(await screen.findByText("Non chargée")).toBeInTheDocument();
      expect(screen.queryByText("7 catégories")).not.toBeInTheDocument();
    });
  });

  describe("sonde du fournisseur IA", () => {
    it("aucune sonde au chargement : /health est appelé SANS probe", async () => {
      renderStatus();
      await screen.findByText("En marche");
      for (const call of vi.mocked(Api.health).mock.calls) {
        expect(call[0]).not.toBe(true);
      }
      expect(screen.getByText("clé enregistrée — validité NON vérifiée")).toBeInTheDocument();
    });

    it("« Tester la connexion » soumet un vrai ticket et affiche le verdict", async () => {
      vi.mocked(Api.testLlm).mockResolvedValue(llmTest());
      renderStatus();
      const btn = await screen.findByRole("button", { name: "Tester la connexion" });
      await userEvent.click(btn);
      await waitFor(() => expect(screen.getByText("Opérationnel")).toBeInTheDocument());
      expect(Api.testLlm).toHaveBeenCalled();
      expect(screen.getByText("le modèle a rendu une Décision exploitable")).toBeInTheDocument();
      // Le modèle et la latence mesurée : un « vert » muet ne prouverait rien.
      expect(screen.getByText(/mistral-large-latest · 940 ms/)).toBeInTheDocument();
    });

    it("une clé refusée par le fournisseur devient visible", async () => {
      vi.mocked(Api.testLlm).mockResolvedValue(
        llmTest({ ok: false, stage: "unreachable", error: "401 Unauthorized" }),
      );
      renderStatus();
      await userEvent.click(await screen.findByRole("button", { name: "Tester la connexion" }));
      await waitFor(() => expect(screen.getByText("Injoignable")).toBeInTheDocument());
      expect(screen.getByText("aucun appel n'a abouti")).toBeInTheDocument();
      expect(screen.getByText("401 Unauthorized")).toBeInTheDocument();
    });

    // La panne que l'ancienne sonde (`GET /models`) ne pouvait PAS voir : le fournisseur
    // répond, la clé est bonne, et pourtant le triage enverrait tout « à trier ».
    it("distingue un fournisseur qui répond d'un fournisseur dont la sortie est inexploitable", async () => {
      vi.mocked(Api.testLlm).mockResolvedValue(
        llmTest({ ok: false, stage: "invalid_output", error: "JSON non parsable" }),
      );
      renderStatus();
      await userEvent.click(await screen.findByRole("button", { name: "Tester la connexion" }));
      await waitFor(() => expect(screen.getByText("Sortie inexploitable")).toBeInTheDocument());
      expect(screen.getByText(/tout partirait « à trier »/)).toBeInTheDocument();
      expect(screen.queryByText("Injoignable")).not.toBeInTheDocument();
    });

    it("un échec réseau du test s'affiche sans casser la page", async () => {
      vi.mocked(Api.testLlm).mockRejectedValue(new Error("API 503"));
      renderStatus();
      await userEvent.click(await screen.findByRole("button", { name: "Tester la connexion" }));
      expect(await screen.findByText(/Échec du test/)).toBeInTheDocument();
    });
  });
  // Le moteur poll à intervalle fixe. Entre deux battements, un exploitant qui vient de
  // brancher GLPI ou de coller une clé n'a rien à regarder : ce bouton lance LE cycle du
  // scheduler (mêmes gardes), et la page rend ce qu'il a produit.
  describe("cycle déclenché à la main", () => {
    function pollRun(over: Partial<PollRunResult> = {}): PollRunResult {
      return {
        outcome: "ran",
        ran: true,
        duration_ms: 1240,
        cycle: {
          has_run: true,
          run_at: new Date().toISOString(),
          // Compteurs VOLONTAIREMENT distincts de ceux du fixture de démo (12/3/9) :
          // sinon l'assertion ne saurait pas si elle lit le message du cycle manuel ou la
          // carte du dernier cycle, qui affiche la même phrase.
          fetched: 7,
          processed: 2,
          skipped_done: 5,
          skipped_scope: 0,
          errors: 0,
          error_message: null,
        },
        ...over,
      };
    }

    it("rend les compteurs du cycle qui vient de tourner", async () => {
      vi.mocked(Api.runPoll).mockResolvedValue(pollRun());
      renderStatus();
      await userEvent.click(await screen.findByRole("button", { name: "Lancer un cycle" }));
      expect(
        await screen.findByText(/Cycle terminé en 1240 ms — 7 vus, 2 triés, 5 déjà traités/),
      ).toBeInTheDocument();
      // Les compteurs de la page viennent de /api/status : sans rechargement, la carte du
      // dernier cycle resterait sur le cycle PRÉCÉDENT sous un message de succès.
      await waitFor(() => expect(Api.status).toHaveBeenCalledTimes(2));
    });

    // La pause est l'arrêt d'urgence du produit (licence expirée, fournisseur qui dérape) :
    // un bouton qui la contournerait la viderait de son sens. On le DIT, on ne le fait pas.
    it("ne contourne pas la pause du polling et dit pourquoi", async () => {
      vi.mocked(Api.runPoll).mockResolvedValue(
        pollRun({ outcome: "polling_disabled", ran: false, duration_ms: 2 }),
      );
      renderStatus();
      await userEvent.click(await screen.findByRole("button", { name: "Lancer un cycle" }));
      expect(await screen.findByText(/Le polling est en pause/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Réactiver l'ingestion" })).toBeInTheDocument();
      // Surtout pas de compteurs : aucun cycle n'a tourné.
      expect(screen.queryByText(/Cycle terminé/)).not.toBeInTheDocument();
    });

    it("affiche l'échec sans casser la page", async () => {
      vi.mocked(Api.runPoll).mockRejectedValue(new Error("API 503"));
      renderStatus();
      await userEvent.click(await screen.findByRole("button", { name: "Lancer un cycle" }));
      expect(await screen.findByText(/Cycle impossible/)).toBeInTheDocument();
    });
  });
});
