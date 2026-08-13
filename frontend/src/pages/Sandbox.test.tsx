import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError, type ConfigView } from "@/lib/api";
import { Sandbox } from "./Sandbox";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, sandbox: vi.fn(), getConfig: vi.fn(), testMask: vi.fn() },
  };
});

/** Config minimale : seul le seuil de confiance est lu par l'écran. */
const CONFIG = { confidence_threshold: "0.7" } as ConfigView;

/** Le champ « Contenu » — `getByRole("textbox")` est ambigu depuis l'ajout du titre. */
const contenu = () => screen.getByLabelText(/Contenu du ticket/);

describe("Sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.getConfig).mockResolvedValue(CONFIG);
    vi.mocked(Api.testMask).mockResolvedValue({ masked: "texte masqué", counts: {} });
  });

  it("désactive le bouton tant que le texte est vide", () => {
    render(<Sandbox />);
    expect(screen.getByRole("button", { name: "Simuler la décision" })).toBeDisabled();
  });

  it("simule une décision et affiche le résultat (accepté + brouillon)", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue({
      accepted: true,
      reason: "accepted",
      category: 3,
      category_name: "Poste de travail",
      priority: 2,
      technician_id: 11,
      technician_name: "Sylvain Martin",
      group_id: null,
      group_name: null,
      confidence: 0.9,
      draft: "Bonjour, nous avons réinitialisé votre mot de passe.",
    });
    render(<Sandbox />);
    await userEvent.type(contenu(), "mdp refusé");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    // Le titre est TOUJOURS transmis (vide ici) : le moteur réel concatène titre + contenu.
    expect(Api.sandbox).toHaveBeenCalledWith("mdp refusé", "");
    expect(await screen.findByText("passe les garde-fous")).toBeInTheDocument();
    // Noms résolus affichés avec l'id en discrétion : « Nom (#id) ».
    expect(screen.getByText("Sylvain Martin (#11)")).toBeInTheDocument();
    expect(screen.getByText("Poste de travail (#3)")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText(/réinitialisé votre mot de passe/)).toBeInTheDocument();
  });

  it("le TITRE saisi est envoyé avec le contenu (essai représentatif)", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue({
      accepted: true,
      reason: "accepted",
      category: 3,
      category_name: null,
      priority: 2,
      technician_id: null,
      technician_name: null,
      group_id: null,
      group_name: null,
      confidence: 0.9,
      draft: null,
    });
    render(<Sandbox />);
    await userEvent.type(screen.getByLabelText(/Titre du ticket/), "Imprimante HS");
    await userEvent.type(contenu(), "bourrage papier");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    await waitFor(() =>
      expect(Api.sandbox).toHaveBeenCalledWith("bourrage papier", "Imprimante HS"),
    );
  });

  it("un exemple pré-rempli permet de démarrer sans rien taper", async () => {
    render(<Sandbox />);
    // Bouton d'exemple (le titre est le libellé) — à ne pas confondre avec le champ.
    await userEvent.click(screen.getByRole("button", { name: "Mot de passe refusé" }));
    expect(screen.getByLabelText(/Titre du ticket/)).toHaveValue("Mot de passe refusé");
    expect((contenu() as HTMLTextAreaElement).value).toContain("mdp refusé");
    expect(screen.getByRole("button", { name: "Simuler la décision" })).toBeEnabled();
  });

  // ── Le verdict, cœur de l'écran ───────────────────────────────────────────────
  // La Décision LLM brute est conservée même REJETÉE (domain/engine.evaluate) pour
  // expliquer le refus. Rendue sans verdict, elle se lit comme un routage qui aura lieu.

  it("un refus annonce le BLOCAGE et nomme l'étape — pas « liste blanche » par défaut", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue({
      accepted: false,
      reason: "low_confidence",
      category: 7,
      category_name: null,
      priority: 3,
      technician_id: 42,
      technician_name: null,
      group_id: null,
      group_name: null,
      confidence: 0.4,
      draft: "Demande à clarifier.",
    });
    render(<Sandbox />);
    await userEvent.type(contenu(), "xx");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    expect(await screen.findByText(/Le moteur BLOQUE cette décision/)).toBeInTheDocument();
    expect(screen.getByText(/Rien ne serait écrit dans GLPI/)).toBeInTheDocument();
    // `low_confidence` = le SEUIL, jamais la whitelist : l'étape nommée doit le dire.
    expect(screen.getByText(/Refus à l'étape : seuil de confiance/)).toBeInTheDocument();
    expect(screen.getByText("Confiance sous le seuil")).toBeInTheDocument();
    expect(screen.queryByText(/liste blanche/i)).not.toBeInTheDocument();
    // Repli sur T#id si le nom n'est pas résolu (référentiel non scanné).
    expect(screen.getByText("T#42")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("affiche le SEUIL à côté de la confiance (sinon 40 % ne veut rien dire)", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue({
      accepted: false,
      reason: "low_confidence",
      category: 7,
      category_name: null,
      priority: 3,
      technician_id: null,
      technician_name: null,
      group_id: null,
      group_name: null,
      confidence: 0.4,
      draft: null,
    });
    render(<Sandbox />);
    await userEvent.type(contenu(), "xx");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    expect(await screen.findByText("seuil 70 %")).toBeInTheDocument();
  });

  it("montre le TEXTE DU TICKET tel qu'il part — jamais le brut, et sans promettre le prompt entier", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue({
      accepted: true,
      reason: "accepted",
      category: 1,
      category_name: null,
      priority: 3,
      technician_id: null,
      technician_name: null,
      group_id: null,
      group_name: null,
      confidence: 0.9,
      draft: null,
    });
    vi.mocked(Api.testMask).mockResolvedValue({
      masked: "mon mail est [EMAIL]",
      counts: { email: 1 },
    });
    render(<Sandbox />);
    await userEvent.type(contenu(), "mon mail est alice@acme.com");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    const bloc = (await screen.findByText("mon mail est [EMAIL]")).closest(
      "details",
    ) as HTMLElement;
    // Anti-PII : le bloc n'affiche QUE la sortie du masqueur — jamais le brut re-rendu
    // à côté « pour comparer », ce qui referait fuir la PII sur l'écran censé la protéger.
    expect(bloc.textContent).not.toContain("alice@acme.com");
    expect(Api.testMask).toHaveBeenCalledWith("mon mail est alice@acme.com");
    // Le titre ne doit promettre que ce qu'il montre : « Texte réellement envoyé au LLM »
    // annonçait le prompt émis, qui contient en plus le prompt système, le catalogue de
    // catégories et les fiches techniciens — jamais affichés ici.
    expect(screen.getByText("Texte du ticket tel qu'il part au LLM (masqué)")).toBeInTheDocument();
    expect(screen.queryByText(/Texte réellement envoyé au LLM/)).not.toBeInTheDocument();
    expect(bloc.textContent).toContain("le prompt système");
  });

  // ── Quand il n'y a AUCUNE proposition ────────────────────────────────────────
  // `llm_error` / `invalid_output` : `outcome.decision` vaut None côté backend, les cinq
  // lignes de détail n'affichent donc que des « — » sous un bandeau qui promet « la
  // proposition du LLM ». Une panne se lisait comme un routage vide.

  /** Réponse sans Décision : tous les champs de routage sont nuls (routes/sandbox.py). */
  const sansDecision = (reason: string) => ({
    accepted: false,
    reason,
    category: null,
    category_name: null,
    priority: null,
    technician_id: null,
    technician_name: null,
    group_id: null,
    group_name: null,
    confidence: null,
    draft: null,
  });

  it("un échec du fournisseur dit qu'aucune proposition n'est revenue", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue(sansDecision("llm_error"));
    render(<Sandbox />);
    await userEvent.type(contenu(), "xx");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    expect(await screen.findByText(/Aucune proposition n'a été produite/)).toBeInTheDocument();
    expect(screen.getByText(/L'appel au fournisseur IA a échoué/)).toBeInTheDocument();
    // Plus de promesse de proposition, ni de lignes de détail vides à interpréter.
    expect(screen.queryByText(/proposition du LLM/)).not.toBeInTheDocument();
    expect(screen.queryByText("Routage — catégorie")).not.toBeInTheDocument();
    expect(screen.queryByText("Confiance")).not.toBeInTheDocument();
    // Le motif reste dit, et l'étape désignée est bien l'appel au LLM.
    expect(screen.getByText("Erreur du fournisseur IA")).toBeInTheDocument();
    expect(screen.getByText(/Refus à l'étape : appel au LLM/)).toBeInTheDocument();
  });

  it("une réponse illisible ne se confond pas avec un appel qui a échoué", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue(sansDecision("invalid_output"));
    render(<Sandbox />);
    await userEvent.type(contenu(), "xx");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    expect(await screen.findByText(/sa réponse était inexploitable/)).toBeInTheDocument();
    expect(screen.queryByText(/L'appel au fournisseur IA a échoué/)).not.toBeInTheDocument();
    expect(screen.getByText("Réponse du LLM illisible")).toBeInTheDocument();
    expect(screen.queryByText("Routage — catégorie")).not.toBeInTheDocument();
  });

  it("affiche le coût, le modèle et la latence de l'essai", async () => {
    vi.mocked(Api.sandbox).mockResolvedValue({
      accepted: true,
      reason: "accepted",
      category: 1,
      category_name: null,
      priority: 3,
      technician_id: null,
      technician_name: null,
      group_id: null,
      group_name: null,
      confidence: 0.9,
      draft: null,
      model: "mistral-small-latest",
      cost_eur: 0.0052,
      prompt_tokens: 1000,
      completion_tokens: 500,
    });
    render(<Sandbox />);
    await userEvent.type(contenu(), "pc lent");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    expect(await screen.findByText("mistral-small-latest")).toBeInTheDocument();
    expect(screen.getByText(/0\.0052 €/)).toBeInTheDocument();
    expect(screen.getByText(/1000 → 500/)).toBeInTheDocument();
    expect(screen.getByText(/Latence/)).toBeInTheDocument();
  });

  it("annonce l'attente (aria-busy) au lieu de laisser « Aucune simulation »", async () => {
    let resolve!: (v: Awaited<ReturnType<typeof Api.sandbox>>) => void;
    vi.mocked(Api.sandbox).mockReturnValue(new Promise((r) => (resolve = r)));
    render(<Sandbox />);
    await userEvent.type(contenu(), "pc lent");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));

    const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Aucune simulation")).not.toBeInTheDocument();

    resolve({
      accepted: true,
      reason: "accepted",
      category: 1,
      category_name: null,
      priority: 3,
      technician_id: null,
      technician_name: null,
      group_id: null,
      group_name: null,
      confidence: 0.9,
      draft: null,
    });
    await waitFor(() => expect(live).toHaveAttribute("aria-busy", "false"));
  });

  it("affiche le message d'erreur du backend (detail.message) en role=alert", async () => {
    // Depuis la centralisation dans ApiError, `message` porte déjà detail.message.
    vi.mocked(Api.sandbox).mockRejectedValue(
      new ApiError(422, { detail: { message: "Texte hors périmètre." } }),
    );
    render(<Sandbox />);
    await userEvent.type(contenu(), "blabla");
    await userEvent.click(screen.getByRole("button", { name: "Simuler la décision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Texte hors périmètre.");
  });
});
