import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Store } from "./Store";

describe("Store (vitrine open-core)", () => {
  it("affiche modules communauté et entreprise par défaut", () => {
    render(<Store />);
    expect(screen.getByText("Multi-fournisseurs LLM")).toBeInTheDocument(); // communauté
    expect(screen.getByText("Masquage avancé (NER)")).toBeInTheDocument(); // entreprise
  });

  it("filtre sur Entreprise masque les modules communauté", async () => {
    render(<Store />);
    await userEvent.click(screen.getByRole("button", { name: "Entreprise" }));
    expect(screen.getByText("Masquage avancé (NER)")).toBeInTheDocument();
    expect(screen.queryByText("Multi-fournisseurs LLM")).not.toBeInTheDocument();
  });

  it("affiche un avis « bientôt » à l'activation de licence", async () => {
    render(<Store />);
    await userEvent.click(screen.getByRole("button", { name: "Activer" }));
    expect(await screen.findByText(/version entreprise arrive/)).toBeInTheDocument();
  });
});
