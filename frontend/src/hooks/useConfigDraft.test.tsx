import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConfigDraft } from "@/hooks/useConfigDraft";
import { Api, type ConfigUpdate, type ConfigView } from "@/lib/api";
import { demo } from "@/lib/demo";
import { renderWithToast } from "@/test-utils";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, Api: { ...actual.Api, getConfig: vi.fn(), updateConfig: vi.fn() } };
});

/**
 * Le hook partagé par les six écrans de réglages — et le SEUL code de cette branche qui
 * n'avait aucun test.
 *
 * C'est le paradoxe du refactoring : cette mécanique a été extraite précisément parce
 * qu'elle est délicate, et les deux tests de régression qui la gardaient sont morts avec la
 * page dont on l'a tirée. Mesuré : neutraliser la garde anti-écrasement (`!edite.current`)
 * laissait les 451 tests du front au vert.
 *
 * ⚠️ Piège de rédaction, rencontré en écrivant ces tests : `mockResolvedValue(objet)` rend
 * la MÊME identité à chaque appel, donc `useResource` ne voit pas `data` changer et l'effet
 * de fusion ne rejoue jamais — un test ainsi écrit passe pour la mauvaise raison. D'où
 * `mockImplementation(async () => ({ ...objet }))` partout ici.
 */

interface Draft {
  seuil: string;
}
const toDraft = (c: ConfigView | null): Draft => ({ seuil: c?.confidence_threshold ?? "" });
const toPayload = (d: Draft): ConfigUpdate => ({ confidence_threshold: Number(d.seuil) });

/** Écran sonde : le plus petit consommateur possible du hook. */
function Sonde() {
  const cfg = useConfigDraft(toDraft, toPayload, "enregistré");
  return (
    <div>
      <label htmlFor="s">Seuil</label>
      <input
        id="s"
        value={cfg.draft.seuil}
        onChange={(e) => cfg.patch({ seuil: e.target.value })}
      />
      <button type="button" onClick={() => cfg.save()}>
        Enregistrer
      </button>
      <p>{cfg.dirty ? "modifié" : "à jour"}</p>
    </div>
  );
}

function differe<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const config = (seuil: string): ConfigView => ({ ...demo.config, confidence_threshold: seuil });

describe("useConfigDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockImplementation(async () => config("0.7"));
    vi.mocked(Api.updateConfig).mockImplementation(async () => config("0.7"));
  });

  it("sans saisie en cours, une relecture REPREND la valeur du serveur", async () => {
    // Le pendant indispensable du test suivant : le drapeau ne doit pas figer le brouillon,
    // sinon une valeur NORMALISÉE par le serveur ne remonterait jamais à l'écran.
    renderWithToast(<Sonde />);
    await screen.findByDisplayValue("0.7");

    vi.mocked(Api.getConfig).mockImplementation(async () => config("0.85"));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(screen.getByLabelText("Seuil")).toHaveValue("0.85"));
  });

  it("une saisie faite PENDANT la relecture n'est pas écrasée", async () => {
    renderWithToast(<Sonde />);
    await screen.findByDisplayValue("0.7");

    // La relecture est mise en vol, puis on tape par-dessus.
    const relecture = differe<ConfigView>();
    vi.mocked(Api.getConfig).mockReturnValue(relecture.promise);
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await userEvent.clear(screen.getByLabelText("Seuil"));
    await userEvent.type(screen.getByLabelText("Seuil"), "0.95");

    relecture.resolve(config("0.7"));

    // Le serveur répond « 0.7 » : sans la garde, la réponse écrase la saisie SANS UN MOT.
    await waitFor(() => expect(Api.getConfig).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Seuil")).toHaveValue("0.95");
  });

  it("une saisie faite PENDANT l'enregistrement n'est pas écrasée non plus", async () => {
    // La moitié qui manquait : le drapeau était baissé au RETOUR du POST, alors que la
    // fenêtre à protéger commence au CLIC. Les champs ne sont pas désactivés le temps de
    // l'aller-retour, donc tout ce qui était tapé entre les deux disparaissait.
    renderWithToast(<Sonde />);
    await screen.findByDisplayValue("0.7");

    const envoi = differe<ConfigView>();
    vi.mocked(Api.updateConfig).mockReturnValue(envoi.promise);
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await userEvent.clear(screen.getByLabelText("Seuil"));
    await userEvent.type(screen.getByLabelText("Seuil"), "0.95");

    envoi.resolve(config("0.7"));

    await waitFor(() => expect(Api.getConfig).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Seuil")).toHaveValue("0.95");
  });

  it("rend `false` quand le serveur refuse — un appelant doit pouvoir le distinguer", async () => {
    // Sans cette valeur, les pages enchaînaient leur relecture après un échec : la page se
    // rafraîchissait comme après un succès, ce qui accrédite l'enregistrement.
    const vus: boolean[] = [];
    function SondeResultat() {
      const cfg = useConfigDraft(toDraft, toPayload, "enregistré");
      return (
        <button
          type="button"
          onClick={async () => {
            cfg.patch({ seuil: "0.9" });
            vus.push(await cfg.save());
          }}
        >
          Enregistrer
        </button>
      );
    }
    vi.mocked(Api.updateConfig).mockRejectedValue(new Error("503"));
    renderWithToast(<SondeResultat />);
    await waitFor(() => expect(Api.getConfig).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(vus).toEqual([false]));
  });

  it("une garde qui refuse annule tout : aucun appel réseau", async () => {
    function SondeGarde() {
      const cfg = useConfigDraft(toDraft, toPayload, "enregistré");
      return (
        <button type="button" onClick={() => cfg.save(() => false)}>
          Enregistrer
        </button>
      );
    }
    renderWithToast(<SondeGarde />);
    await waitFor(() => expect(Api.getConfig).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(Api.updateConfig).not.toHaveBeenCalled();
  });

  it("une projection INSTABLE ne boucle pas — le contrat est tenu par le code", async () => {
    // Passées en dépendances, `toDraft`/`toPayload` recréées à chaque rendu bouclaient :
    // nouvelle identité → effet → setDraft → rendu → nouvelle identité (« Maximum update
    // depth exceeded »). React finit par couper, donc la page s'affiche et seule la console
    // hurle : le pire des symptômes. Les projections sont désormais figées au premier rendu.
    const erreurs: unknown[] = [];
    const espion = vi.spyOn(console, "error").mockImplementation((...a) => erreurs.push(a));
    function SondeInstable() {
      // Volontairement défini DANS le corps : identité neuve à chaque rendu.
      const projection = (c: ConfigView | null): Draft => ({
        seuil: c?.confidence_threshold ?? "",
      });
      const cfg = useConfigDraft(projection, toPayload, "enregistré");
      return <span>{cfg.draft.seuil || "vide"}</span>;
    }
    render(<SondeInstable />);
    await waitFor(() => expect(screen.getByText("0.7")).toBeInTheDocument());

    expect(erreurs.flat().join(" ")).not.toContain("Maximum update depth");
    espion.mockRestore();
  });
});
