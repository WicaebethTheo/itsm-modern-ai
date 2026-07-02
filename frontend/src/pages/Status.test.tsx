import { Api } from "@/lib/api";
import { demo } from "@/lib/demo";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Status } from "./Status";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    Api: { ...actual.Api, status: vi.fn(), health: vi.fn(), getConfig: vi.fn() },
  };
});

describe("Status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Api.status).mockResolvedValue(demo.status);
    vi.mocked(Api.health).mockResolvedValue(demo.health);
    vi.mocked(Api.getConfig).mockResolvedValue(demo.config);
  });

  it("affiche l'état des services (worker, GLPI, liste blanche)", async () => {
    render(<Status />);
    expect(await screen.findByText("En marche")).toBeInTheDocument(); // worker (polling on)
    expect(screen.getByText("Connecté")).toBeInTheDocument(); // GLPI joignable
    // Liste blanche : categories_count / technicians_count
    expect(
      screen.getByText(`${demo.status.categories_count} / ${demo.status.technicians_count}`),
    ).toBeInTheDocument();
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
});
