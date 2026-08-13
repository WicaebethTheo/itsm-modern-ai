import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./toast";

function Trigger({ message, kind }: { message: string; kind: "success" | "error" }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast[kind](message)}>
      fire
    </button>
  );
}

describe("ToastProvider", () => {
  it("affiche un toast success quand on appelle useToast().success", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger message="Sauvegardé." kind="success" />
      </ToastProvider>,
    );
    await user.click(screen.getByText("fire"));
    expect(await screen.findByText("Sauvegardé.")).toBeInTheDocument();
  });

  it("auto-dismiss après 3 s", () => {
    // Timers factices, comme le cas des erreurs juste en dessous : attendre RÉELLEMENT 3 s
    // ne prouvait rien de plus et coûtait 3 s à chaque exécution de la suite.
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Trigger message="Réglages enregistrés." kind="success" />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByText("fire"));
      expect(screen.getByText("Réglages enregistrés.")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(screen.getByText("Réglages enregistrés.")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByText("Réglages enregistrés.")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("les erreurs restent affichées 6 s (au-delà des 3 s des succès)", () => {
    // Timers factices : on avance l'horloge sans attendre réellement 6 s.
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Trigger message="Échec réseau" kind="error" />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByText("fire"));
      act(() => {
        vi.advanceTimersByTime(3500);
      });
      // Toujours visible après 3 s (un succès aurait déjà disparu).
      expect(screen.getByText("Échec réseau")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.queryByText("Échec réseau")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ferme immédiatement au clic sur le bouton de fermeture", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger message="Erreur réseau" kind="error" />
      </ToastProvider>,
    );
    await user.click(screen.getByText("fire"));
    expect(await screen.findByText("Erreur réseau")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Fermer"));
    expect(screen.queryByText("Erreur réseau")).not.toBeInTheDocument();
  });

  it("no-op silencieux quand utilisé hors Provider (tests unitaires de page)", async () => {
    const user = userEvent.setup();
    render(<Trigger message="x" kind="success" />);
    await user.click(screen.getByText("fire"));
    expect(screen.queryByText("x")).not.toBeInTheDocument();
  });
});
