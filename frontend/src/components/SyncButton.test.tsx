import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api } from "@/lib/api";
import { dernierScan, SyncButton } from "./SyncButton";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, syncGlpi: vi.fn() } };
});

const scanner = () => userEvent.click(screen.getByRole("button", { name: "Scanner GLPI" }));

describe("SyncButton — le résultat du scan", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rend compte de ce que le scan a RAMENÉ, pas seulement qu'il a eu lieu", async () => {
    // `SyncResult.counts` était intégralement jeté : un scan qui ramène 0 technicien (droits
    // GLPI insuffisants) s'annonçait exactement comme un scan complet.
    vi.mocked(Api.syncGlpi).mockResolvedValue({
      ok: true,
      detail: "Référentiels synchronisés.",
      counts: { category: 12, entity: 2, technician: 0, group: 3 },
    });
    const onSynced = vi.fn();
    render(<SyncButton onSynced={onSynced} />);
    await scanner();

    const etat = await screen.findByRole("status");
    expect(etat.textContent).toContain("12 catégories");
    expect(etat.textContent).toContain("0 techniciens");
    expect(etat.textContent).toContain("3 groupes");
    await waitFor(() => expect(onSynced).toHaveBeenCalledTimes(1));
  });

  it("un échec ne ressemble PAS à un succès — la cause exacte, en rouge", async () => {
    // Le backend répond HTTP 200 avec ok:false et un `detail` qui porte la cause : c'est le
    // canal d'erreur le plus riche du produit hors mode debug, et il s'affichait en gris
    // muté, à l'identique de « Référentiels synchronisés. ».
    vi.mocked(Api.syncGlpi).mockResolvedValue({
      ok: false,
      detail: "Authentification GLPI refusée (401)",
      counts: {},
    });
    const onSynced = vi.fn();
    render(<SyncButton onSynced={onSynced} />);
    await scanner();

    const etat = await screen.findByRole("status");
    expect(etat.textContent).toContain("Authentification GLPI refusée (401)");
    expect(etat.className).toContain("text-destructive");
    // Rien n'a été rafraîchi : recharger la liste sur un scan raté n'apporterait rien.
    expect(onSynced).not.toHaveBeenCalled();
  });

  it("remonte aussi une panne réseau (exception, pas ok:false)", async () => {
    vi.mocked(Api.syncGlpi).mockRejectedValue(new Error("GLPI injoignable"));
    render(<SyncButton onSynced={vi.fn()} />);
    await scanner();
    expect(await screen.findByText(/GLPI injoignable/)).toBeInTheDocument();
  });
});

describe("SyncButton — fraîcheur du cache", () => {
  const ilYA = (jours: number) => new Date(Date.now() - jours * 86_400_000).toISOString();

  beforeEach(() => vi.clearAllMocks());

  it("dit de quand date la liste affichée", async () => {
    render(<SyncButton onSynced={vi.fn()} lastSync={ilYA(2)} />);
    expect(screen.getByText(/Dernière synchro/)).toBeInTheDocument();
    expect(screen.queryByText(/Référentiels anciens/)).not.toBeInTheDocument();
  });

  it("alerte au-delà de 30 jours — un technicien parti depuis y figure encore", async () => {
    render(<SyncButton onSynced={vi.fn()} lastSync={ilYA(45)} />);
    expect(screen.getByText(/Référentiels anciens — relancez un scan/)).toBeInTheDocument();
  });

  it("ne prétend rien quand le serveur ne donne pas la date", async () => {
    // Pas de repli sur localStorage : sur une console partagée, chaque navigateur
    // afficherait « sa » date de dernière synchro, ce qui serait un mensonge.
    render(<SyncButton onSynced={vi.fn()} lastSync={null} />);
    expect(screen.queryByText(/Dernière synchro/)).not.toBeInTheDocument();
  });
});

describe("dernierScan", () => {
  it("retient l'horodatage le plus récent et tolère son absence", () => {
    expect(
      dernierScan([
        { updated_at: "2026-01-05T10:00:00+00:00" },
        { updated_at: "2026-03-05T10:00:00+00:00" },
        {},
      ]),
    ).toBe("2026-03-05T10:00:00+00:00");
    expect(dernierScan([{}, {}])).toBeNull();
    expect(dernierScan([])).toBeNull();
  });
});
