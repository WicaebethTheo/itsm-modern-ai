import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_VERSION,
  Api,
  ApiError,
  api,
  asBool,
  type EngineStatus,
  navigation,
  readPollCycle,
  updateCommand,
} from "./api";

describe("asBool", () => {
  it("reconnaît les valeurs vraies (config en chaîne)", () => {
    for (const v of ["1", "true", "yes", "on", "vrai", "TRUE", " on "]) {
      expect(asBool(v)).toBe(true);
    }
  });

  it("renvoie false pour les valeurs fausses ou absentes", () => {
    for (const v of ["0", "false", "no", "", "n'importe", null, undefined]) {
      expect(asBool(v)).toBe(false);
    }
  });
});

describe("ApiError — messages centralisés", () => {
  // setup.ts fige la locale des tests sur « fr ».
  it("privilégie detail.message du backend quand il est présent", () => {
    const err = new ApiError(400, { detail: { message: "Plafond de coût dépassé." } });
    expect(err.message).toBe("Plafond de coût dépassé.");
  });

  it("libellés par status connus (401/403/404/500), sinon API <status>", () => {
    expect(new ApiError(401, null).message).toBe("Session expirée");
    expect(new ApiError(403, null).message).toBe("Accès refusé");
    expect(new ApiError(404, null).message).toBe("Ressource introuvable");
    expect(new ApiError(500, null).message).toBe("Erreur interne du serveur");
    expect(new ApiError(418, null).message).toBe("API 418");
  });

  it("les libellés suivent la langue courante (EN par défaut hors « fr »)", () => {
    localStorage.setItem("itsm-lang", "en");
    expect(new ApiError(401, null).message).toBe("Session expired");
  });

  it("accepte un detail string (style FastAPI par défaut), ignore un message non-chaîne", () => {
    expect(new ApiError(404, { detail: "texte brut" }).message).toBe("texte brut");
    expect(new ApiError(404, { detail: { message: 42 } }).message).toBe("Ressource introuvable");
  });
});

describe("request — parsing et session", () => {
  function mockFetch(status: number, body: string) {
    const fn = vi.fn().mockResolvedValue(new Response(body, { status }));
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("réponse non-JSON (page HTML d'un reverse proxy) → ApiError avec le status", async () => {
    mockFetch(502, "<html><body>Bad Gateway</body></html>");
    const err = await api.get("/api/status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).toBe("API 502");
    // Le payload minimal garde un extrait brut pour le debug.
    expect((err as ApiError).payload).toEqual({ raw: "<html><body>Bad Gateway</body></html>" });
  });

  it("réponse 200 mais corps illisible → ApiError aussi (pas de SyntaxError brut)", async () => {
    mockFetch(200, "pas du json");
    const err = await api.get("/api/status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(200);
  });

  it("401 hors /api/auth/* → message « Session expirée » + redirection vers le login", async () => {
    const toLogin = vi.spyOn(navigation, "toLogin").mockImplementation(() => {});
    mockFetch(401, JSON.stringify({ detail: { code: "unauthorized" } }));
    const err = await api.get("/api/config").catch((e: unknown) => e);
    expect((err as ApiError).message).toBe("Session expirée");
    expect(toLogin).toHaveBeenCalledTimes(1);
  });

  it("401 sur /api/auth/* → PAS de redirection (le login affiche sa propre erreur)", async () => {
    const toLogin = vi.spyOn(navigation, "toLogin").mockImplementation(() => {});
    mockFetch(401, "{}");
    await expect(api.post("/api/auth/login", { password: "x" })).rejects.toBeInstanceOf(ApiError);
    expect(toLogin).not.toHaveBeenCalled();
  });
});

describe("readPollCycle — état du dernier cycle de polling", () => {
  const base: EngineStatus = { ok: true, version: "0.0.0", polling_enabled: true };

  it("bloc absent sur un moteur d'une AUTRE version → « non exposé » (rien à affirmer)", () => {
    expect(readPollCycle(base)).toEqual({ kind: "unavailable" });
    expect(readPollCycle(null)).toEqual({ kind: "unavailable" });
    // Réponse publique (non enrichie) : le bloc est filtré côté moteur, pas absent.
    expect(readPollCycle({ ...base, version: APP_VERSION })).toEqual({ kind: "unavailable" });
  });

  it("bloc absent d'une réponse ENRICHIE du moteur courant → « aucun cycle exécuté »", () => {
    // FastAPI sérialise `/api/status` avec exclude_none : `last_poll = None` est omis,
    // pas rendu à `null`. Sans cette inférence, le symptôme n°1 resterait invisible.
    expect(readPollCycle({ ...base, version: APP_VERSION, polling_interval_seconds: 60 })).toEqual({
      kind: "never",
    });
  });

  it("`last_poll: null` → « aucun cycle exécuté » (état distinct de l'absence de donnée)", () => {
    expect(readPollCycle({ ...base, last_poll: null })).toEqual({ kind: "never" });
  });

  it("`has_run: false` avec des compteurs à 0 → « aucun cycle exécuté »", () => {
    // Charge utile RÉELLE du moteur : `LastPoll` sérialise toujours ses clés, compteurs
    // à 0 compris. S'en remettre à eux classait ce cas en « a tourné » (0 !== null) et la
    // page Statut affichait une pastille verte sur un moteur qui n'avait jamais bouclé.
    expect(
      readPollCycle({
        ...base,
        last_poll: {
          has_run: false,
          run_at: null,
          fetched: 0,
          processed: 0,
          skipped_done: 0,
          skipped_scope: 0,
          errors: 0,
          error_message: null,
        },
      }),
    ).toEqual({ kind: "never" });
  });

  it("bloc imbriqué → compteurs normalisés", () => {
    const state = readPollCycle({
      ...base,
      last_poll: {
        has_run: true,
        run_at: "2026-08-08T19:42:03Z",
        fetched: 12,
        processed: 3,
        skipped_done: 9,
        skipped_scope: 0,
        errors: 0,
        error_message: null,
      },
    });
    expect(state).toEqual({
      kind: "ran",
      cycle: {
        has_run: true,
        run_at: "2026-08-08T19:42:03Z",
        fetched: 12,
        processed: 3,
        skipped_done: 9,
        skipped_scope: 0,
        errors: 0,
        error_message: null,
      },
    });
  });

  it("tolère la forme à plat `poll_last_*` et les compteurs en texte", () => {
    const state = readPollCycle({
      ...base,
      poll_last_run_at: "2026-08-08T19:42:03Z",
      poll_last_fetched: "12" as unknown as number,
      poll_last_errors: 2,
      poll_last_error_message: "GLPI 401",
    });
    expect(state.kind).toBe("ran");
    if (state.kind !== "ran") return;
    expect(state.cycle.fetched).toBe(12);
    expect(state.cycle.errors).toBe(2);
    expect(state.cycle.error_message).toBe("GLPI 401");
    expect(state.cycle.processed).toBeNull(); // champ non remonté ≠ zéro
  });
});

describe("Api.health — le 503 de /health porte le diagnostic, pas une erreur", () => {
  const degraded = {
    status: "degraded",
    glpi: { configured: true, reachable: false, version: null },
    llm: { configured: true, reachable: null },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("503 avec un corps Health → renvoyé tel quel (GLPI injoignable reste lisible)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(degraded), { status: 503 })),
    );
    await expect(Api.health()).resolves.toMatchObject({ glpi: { reachable: false } });
  });

  it("503 sans corps exploitable → l'erreur remonte", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "nope" }), { status: 503 })),
    );
    await expect(Api.health()).rejects.toBeInstanceOf(ApiError);
  });

  it("probe=true est la SEULE voie qui déclenche l'appel sortant vers le LLM", async () => {
    // Une Response ne se lit qu'une fois : on en fabrique une par appel.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify(degraded), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await Api.health();
    expect(fetchMock.mock.calls[0][0]).toBe("/health");
    await Api.health(true);
    expect(fetchMock.mock.calls[1][0]).toBe("/health?probe=true");
  });
});

describe("updateCommand — commande de MAJ selon le runtime", () => {
  it("runtime docker → pull + up (jamais install.sh)", () => {
    expect(updateCommand("docker")).toBe("docker compose pull && docker compose up -d");
  });

  it("runtime hôte (ou inconnu) → install.sh --update", () => {
    expect(updateCommand("host")).toBe("./install.sh --update");
    expect(updateCommand(undefined)).toBe("./install.sh --update");
  });
});
