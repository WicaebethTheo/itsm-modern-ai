import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Toggle } from "./toggle";

describe("Toggle", () => {
  it("reflète l'état coché via aria-checked", () => {
    render(<Toggle checked onChange={() => {}} label="Masquer les e-mails" />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("appelle onChange avec la valeur inversée au clic", async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Masquer les IBAN" />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("affiche le label et le relie au switch (a11y)", () => {
    render(<Toggle checked onChange={() => {}} label="Polling activé" />);
    expect(screen.getByRole("switch", { name: "Polling activé" })).toBeInTheDocument();
  });

  it("n'appelle pas onChange quand il est désactivé", async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="x" disabled />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
