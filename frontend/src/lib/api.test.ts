import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, asBool, navigation, updateCommand } from "./api";

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

describe("updateCommand — commande de MAJ selon le runtime", () => {
  it("runtime docker → pull + up (jamais install.sh)", () => {
    expect(updateCommand("docker")).toBe("docker compose pull && docker compose up -d");
  });

  it("runtime hôte (ou inconnu) → install.sh --update", () => {
    expect(updateCommand("host")).toBe("./install.sh --update");
    expect(updateCommand(undefined)).toBe("./install.sh --update");
  });
});
