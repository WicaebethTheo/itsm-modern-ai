import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PasswordStrength } from "./PasswordStrength";

describe("PasswordStrength", () => {
  it("indique le minimum attendu tant que rien n'est saisi", () => {
    render(<PasswordStrength password="" />);
    expect(screen.getByText(/8 caractères minimum/)).toBeInTheDocument();
  });

  it("décompte les caractères qui manquent, sans reproche", () => {
    render(<PasswordStrength password="abcde" />);
    expect(screen.getByText(/Encore 3 caractère/)).toBeInTheDocument();
  });

  it("annonce le verdict en région live pour un lecteur d'écran", () => {
    render(<PasswordStrength password="Trois chevaux bleus 42 !" id="jauge" />);
    const verdict = screen.getByText(/Robustesse/);
    expect(verdict).toHaveAttribute("aria-live", "polite");
    expect(verdict).toHaveAttribute("id", "jauge");
    expect(verdict).toHaveTextContent("excellent");
  });

  it("suggère un progrès sur un mot de passe juste acceptable", () => {
    render(<PasswordStrength password="abcdefgh" />);
    expect(screen.getByText(/Robustesse : faible/)).toBeInTheDocument();
    expect(screen.getByText(/plus long/)).toBeInTheDocument();
  });
});
