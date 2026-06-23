import { Api, type PrivacyView } from "@/lib/api";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Privacy } from "./Privacy";

// On mocke le module Api : on garde les exports réels (types, DEMO, URLs…) et on
// remplace seulement les méthodes réseau utilisées par la page.
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, privacy: vi.fn(), testMask: vi.fn() },
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
      key: "custom",
      label_fr: "Regex personnalisée",
      label_en: "Custom regex",
      example: "[CUSTOM]",
      scope: "supporter",
      active: false,
    },
  ],
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

  it("affiche le bandeau d'alerte Community", async () => {
    renderPrivacy();
    expect(await screen.findByText(/Édition Community/)).toBeInTheDocument();
  });

  it("rend l'outil de test du masquage (textarea + bouton)", async () => {
    renderPrivacy();
    await screen.findByText("Adresses e-mail");
    expect(screen.getByRole("button", { name: "Tester" })).toBeInTheDocument();
    expect(document.querySelector("textarea")).not.toBeNull();
  });
});
