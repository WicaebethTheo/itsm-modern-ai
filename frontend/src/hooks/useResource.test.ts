import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useResource } from "./useResource";

describe("useResource", () => {
  it("course au reload : seule la réponse la plus récente écrit l'état", async () => {
    // Fetcher contrôlable : chaque appel empile son resolver, on décide de l'ordre.
    const resolvers: ((v: string) => void)[] = [];
    const fetcher = () =>
      new Promise<string>((resolve) => {
        resolvers.push(resolve);
      });

    const { result } = renderHook(() => useResource(fetcher));
    // Chargement initial (n°1) encore en vol → reload() (n°2).
    act(() => result.current.reload());
    expect(resolvers).toHaveLength(2);

    // La requête RÉCENTE (n°2) répond d'abord…
    await act(async () => {
      resolvers[1]?.("récente");
    });
    // …puis l'OBSOLÈTE (n°1) arrive en retard : elle ne doit PAS écraser l'état.
    await act(async () => {
      resolvers[0]?.("obsolète");
    });

    expect(result.current.data).toBe("récente");
    expect(result.current.loading).toBe(false);
  });

  it("fallback d'erreur localisé quand le rejet n'a pas de message", async () => {
    // setup.ts fige la locale des tests sur « fr » → fallback « Erreur ».
    const fetcher = () => Promise.reject({});
    const { result } = renderHook(() => useResource<never>(fetcher));
    await waitFor(() => expect(result.current.error).toBe("Erreur"));
  });
});
