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
import { demo } from "./demo";

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

describe("ApiError — 422 FastAPI (detail en tableau)", () => {
  it("nomme le champ fautif : « Field required » seul n'est pas actionnable", () => {
    const err = new ApiError(422, {
      detail: [{ loc: ["body", "glpi_base_url"], msg: "Value error, URL bloquée (anti-SSRF)" }],
    });
    expect(err.message).toBe("glpi_base_url : URL bloquée (anti-SSRF)");
  });

  it("écarte les messages de validation GÉNÉRIQUES (anglais en dur, non actionnables)", () => {
    // « Input should be less than or equal to 5 » dans une console française n'apprend rien
    // de plus qu'« API 422 » — et n'a aucune traduction. On ne l'affiche donc pas.
    expect(
      new ApiError(422, {
        detail: [
          { loc: ["body", "llm_retries"], msg: "Input should be less than or equal to 5" },
          { loc: ["body", "llm_model"], msg: "Field required" },
        ],
      }).message,
    ).toBe("API 422");
  });

  it("garde les messages de NOS validateurs même mêlés à des messages génériques", () => {
    const err = new ApiError(422, {
      detail: [
        { loc: ["body", "llm_retries"], msg: "Input should be a valid integer" },
        { loc: ["body", "llm_base_url"], msg: "Value error, Appel bloqué (anti-SSRF)" },
      ],
    });
    expect(err.message).toBe("llm_base_url : Appel bloqué (anti-SSRF)");
  });

  it("borne à 3 messages : un rapport de validation entier noierait la cause utile", () => {
    const detail = Array.from({ length: 8 }, (_, i) => ({
      loc: ["body", `champ_${i}`],
      msg: `Value error, cause ${i}`,
    }));
    const err = new ApiError(422, { detail });
    expect(err.message).toBe("champ_0 : cause 0 · champ_1 : cause 1 · champ_2 : cause 2");
  });

  it("sans `loc` exploitable, le message reste affiché tel quel (sans préfixe vide)", () => {
    expect(
      new ApiError(422, { detail: [{ loc: ["body"], msg: "Value error, cause" }] }).message,
    ).toBe("cause");
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

  it("`has_run` se lit comme le reste de la config (« 1 »/« 0 », pas seulement true/false)", () => {
    // Le premier alias de `has_run` est une CLÉ RUNTIME, et la config runtime sérialise ses
    // booléens en « 1 »/« 0 » : n'accepter que « true »/« false » aurait lu le drapeau comme
    // ABSENT — retour direct à la pastille verte sur un moteur qui n'a jamais bouclé.
    const avecDrapeau = (has_run: unknown): EngineStatus =>
      ({ ...base, last_poll: { has_run } }) as unknown as EngineStatus;
    for (const vrai of ["1", "true", "TRUE", " on ", "yes", "vrai", true]) {
      expect(readPollCycle(avecDrapeau(vrai)).kind).toBe("ran");
    }
    for (const faux of ["0", "false", "no", "off", "faux", false]) {
      expect(readPollCycle(avecDrapeau(faux)).kind).toBe("never");
    }
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

describe("fixtures de démo — elles doivent suivre le contrat du moteur", () => {
  // Un fixture qui décrit une charge utile que le moteur n'émet plus est exactement ce qui
  // a laissé passer le bug de la pastille verte : la démo valide alors un contrat MORT.
  it("chaque décision porte `fallback_applied`, dont au moins une avec un repli assigné", () => {
    expect(demo.decisions.every((d) => typeof d.fallback_applied === "boolean")).toBe(true);
    const repli = demo.decisions.filter((d) => d.fallback_applied);
    expect(repli.length).toBeGreaterThan(0);
    // Le moteur n'assigne un repli que sur un REFUS, et hors mode suggestion.
    for (const d of repli) {
      expect(d.accepted).toBe(false);
      expect(d.mode).not.toBe("suggestion");
      expect(d.technician_id ?? d.group_id).not.toBeNull();
    }
  });

  it("chaque référentiel porte `updated_at` (fraîcheur du scan)", () => {
    for (const items of [demo.technicians, demo.groups, demo.categories, demo.entities]) {
      expect(items.length).toBeGreaterThan(0);
      for (const it of items) {
        expect(it.updated_at).toBeTruthy();
        expect(Number.isNaN(new Date(it.updated_at as string).getTime())).toBe(false);
      }
    }
  });

  it("la sandbox de démo renvoie le modèle, le coût et les jetons", async () => {
    // `DEMO` se décide À L'IMPORT, d'après le chemin servi : on rejoue donc l'import du
    // module sur `/demo` pour exercer la branche démo, exactement comme la console publique.
    const avant = window.location.pathname;
    window.history.pushState({}, "", "/demo/sandbox");
    try {
      vi.resetModules();
      const { Api: ApiDemo } = await import("./api");
      const r = await ApiDemo.sandbox("Bonjour", "test");
      // Le moteur renvoie TOUJOURS ce qu'un essai a coûté (routes/sandbox.py) : sans ces
      // trois champs, le bloc de coût de la Sandbox est invisible en démo.
      expect(r.model).toBeTruthy();
      expect(typeof r.cost_eur).toBe("number");
      expect(typeof r.prompt_tokens).toBe("number");
      expect(typeof r.completion_tokens).toBe("number");
    } finally {
      window.history.pushState({}, "", avant);
      vi.resetModules();
    }
  });
});
