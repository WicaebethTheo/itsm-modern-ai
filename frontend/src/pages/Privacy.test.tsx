import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, type PrivacyView, type RetentionView } from "@/lib/api";
import { Privacy } from "./Privacy";

// On mocke le module Api : on garde les exports réels (types, DEMO, URLs…) et on
// remplace seulement les méthodes réseau utilisées par la page.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    // `retention` DOIT figurer ici : la carte Rétention lit l'état réel de la purge,
    // sans ce mock la page part en erreur au chargement.
    Api: { ...actual.Api, privacy: vi.fn(), testMask: vi.fn(), retention: vi.fn() },
  };
});

// Fixture Community : seuls e-mail + téléphone sont actifs, le reste est Supporter/inactif.
const COMMUNITY: PrivacyView = {
  edition_advanced: false,
  retention_decisions_days: 30,
  retention_llm_calls_days: 30,
  llm_calls_count: 42,
  categories: [
    {
      key: "email",
      label_fr: "Adresses e-mail",
      label_en: "Email addresses",
      example: "[EMAIL]",
      scope: "community",
      active: true,
    },
    {
      key: "phone",
      label_fr: "Téléphones",
      label_en: "Phone numbers",
      example: "[PHONE]",
      scope: "community",
      active: true,
    },
    {
      key: "iban",
      label_fr: "IBAN & cartes",
      label_en: "IBAN & cards",
      example: "[IBAN]",
      scope: "supporter",
      active: false,
    },
    {
      key: "secret",
      label_fr: "Secrets / tokens",
      label_en: "Secrets / tokens",
      example: "[SECRET]",
      scope: "supporter",
      active: false,
    },
    {
      key: "network",
      label_fr: "IP & MAC",
      label_en: "IP & MAC",
      example: "[IP]",
      scope: "supporter",
      active: false,
    },
    {
      key: "nir_siret",
      label_fr: "NIR / SIRET",
      label_en: "NIR / SIRET",
      example: "[NIR]",
      scope: "supporter",
      active: false,
    },
    {
      // `roadmap` = capacité pas encore livrée (cf. routes/privacy.py) : ni masquée,
      // ni verrouillable par une licence.
      key: "custom",
      label_fr: "Regex personnalisée",
      label_en: "Custom regex",
      example: "[CUSTOM]",
      scope: "roadmap",
      active: false,
    },
  ],
};

const RETENTION_ON: RetentionView = {
  enabled: true,
  decisions_days: 30,
  llm_calls_days: 30,
  hour_utc: 3,
  last_run_at: "2026-05-30T03:00:00Z",
  last_decisions_deleted: 12,
  last_llm_calls_deleted: 47,
  last_run_by: "scheduler",
};

function renderPrivacy() {
  return render(
    <MemoryRouter>
      <Privacy />
    </MemoryRouter>,
  );
}

describe("Privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.privacy).mockResolvedValue(COMMUNITY);
    vi.mocked(Api.retention).mockResolvedValue(RETENTION_ON);
    vi.mocked(Api.testMask).mockResolvedValue({ masked: "[EMAIL]", counts: { email: 1 } });
  });

  it("affiche les libellés des catégories", async () => {
    renderPrivacy();
    expect(await screen.findByText("Adresses e-mail")).toBeInTheDocument();
    expect(screen.getByText("Téléphones")).toBeInTheDocument();
    expect(screen.getByText("IBAN & cartes")).toBeInTheDocument();
  });

  it("affiche un badge Supporter verrouillé pour les catégories payantes", async () => {
    renderPrivacy();
    await screen.findByText("IBAN & cartes");
    // LockedBadge rend le texte « Supporter » ; au moins une occurrence (iban, secret…).
    expect(screen.getAllByText("Supporter").length).toBeGreaterThan(0);
  });

  it("rend trois états de sortie : masqué, en clair, non implémenté", async () => {
    renderPrivacy();
    await screen.findByText("Adresses e-mail");
    // La colonne répond « qu'est-ce qui sort ? », pas « qu'est-ce qui est payant ? ».
    expect(screen.getByText("Envoyé au LLM", { selector: "th" })).toBeInTheDocument();
    expect(screen.getAllByText("Masqué")).toHaveLength(2); // email + phone
    expect(screen.getAllByText("Envoyé en clair")).toHaveLength(4); // les 4 catégories Supporter
    expect(screen.getByText("Non implémenté")).toBeInTheDocument(); // roadmap
  });

  it("dit « envoyé en clair » pour une catégorie Community DÉSACTIVÉE (sans badge Supporter)", async () => {
    vi.mocked(Api.privacy).mockResolvedValue({
      ...COMMUNITY,
      categories: COMMUNITY.categories.map((c) =>
        c.key === "email" ? { ...c, active: false } : c,
      ),
    });
    renderPrivacy();
    await screen.findByText("Adresses e-mail");
    // Un masquage e-mail décoché est PLUS grave qu'un verrou Supporter : il doit se voir.
    expect(screen.getAllByText("Envoyé en clair")).toHaveLength(5);
    expect(screen.getAllByText("Masqué")).toHaveLength(1); // phone seulement
  });

  it("rend l'outil de test du masquage (textarea + bouton)", async () => {
    renderPrivacy();
    await screen.findByText("Adresses e-mail");
    expect(screen.getByRole("button", { name: "Tester" })).toBeInTheDocument();
    expect(document.querySelector("textarea")).not.toBeNull();
  });

  it("affiche les compteurs du testeur et ce qui n'est PAS masqué", async () => {
    renderPrivacy();
    await screen.findByText("Adresses e-mail");
    await userEvent.click(screen.getByRole("button", { name: "Tester" }));
    expect(await screen.findByText(/E-mails × 1/)).toBeInTheDocument();
    expect(screen.getByText(/Non masqué dans l'état actuel/)).toBeInTheDocument();
  });

  it("annonce « aucun remplacement » quand le texte ressort IDENTIQUE", async () => {
    vi.mocked(Api.testMask).mockResolvedValue({ masked: "rien a masquer", counts: {} });
    renderPrivacy();
    await screen.findByText("Adresses e-mail");
    const zone = document.querySelector("textarea") as HTMLTextAreaElement;
    await userEvent.clear(zone);
    await userEvent.type(zone, "rien a masquer");
    await userEvent.click(screen.getByRole("button", { name: "Tester" }));
    expect(await screen.findByText(/Aucun remplacement/)).toBeInTheDocument();
  });

  it("compte les remplacements de la passe Supporter (NIR/SIRET)", async () => {
    // `routes/privacy.py` déduit ces compteurs des marqueurs ajoutés par l'overlay : sans
    // eux, un texte ne contenant QU'UN NIR revenait avec des compteurs vides.
    vi.mocked(Api.testMask).mockResolvedValue({
      masked: "NIR [NIR] SIREN [SIRET]",
      counts: { nir: 1, siret: 1 },
    });
    renderPrivacy();
    await screen.findByText("Adresses e-mail");
    await userEvent.click(screen.getByRole("button", { name: "Tester" }));
    expect(await screen.findByText(/NIR × 1/)).toBeInTheDocument();
    expect(screen.getByText(/SIREN \/ SIRET × 1/)).toBeInTheDocument();
  });

  it("texte RÉELLEMENT masqué mais sans compteur : ne dit JAMAIS « part tel quel »", async () => {
    // Garde-fou de dernier recours (marqueur d'un plugin hors convention) : la page
    // affichait « Aucun remplacement — ce texte part tel quel au LLM » juste sous le bloc
    // montrant `[NIR]`. Sur l'écran destiné à la DPO, l'outil se contredisait lui-même.
    vi.mocked(Api.testMask).mockResolvedValue({ masked: "NIR [NIR]", counts: {} });
    renderPrivacy();
    await screen.findByText("Adresses e-mail");
    await userEvent.click(screen.getByRole("button", { name: "Tester" }));
    expect(await screen.findByText(/Des données ont été remplacées/)).toBeInTheDocument();
    expect(screen.queryByText(/part tel quel/)).not.toBeInTheDocument();
  });

  it("purge ACTIVE : affiche l'heure de passage et la dernière exécution", async () => {
    renderPrivacy();
    expect(await screen.findByText(/Passage quotidien à 3 h UTC/)).toBeInTheDocument();
    expect(screen.queryByText(/Purge automatique DÉSACTIVÉE/)).not.toBeInTheDocument();
  });

  it("purge DÉSACTIVÉE : avertit que les durées affichées ne purgent rien", async () => {
    vi.mocked(Api.retention).mockResolvedValue({ ...RETENTION_ON, enabled: false });
    renderPrivacy();
    expect(await screen.findByText(/Purge automatique DÉSACTIVÉE/)).toBeInTheDocument();
    // Aucune action destructive sur cette page : la purge se règle sur /automations.
    expect(screen.getByRole("link", { name: "Régler la purge" })).toBeInTheDocument();
  });

  it("erreur de chargement : propose « Réessayer »", async () => {
    vi.mocked(Api.privacy).mockRejectedValue(new Error("boom"));
    renderPrivacy();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    await userEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(Api.privacy).toHaveBeenCalledTimes(2);
  });
});
