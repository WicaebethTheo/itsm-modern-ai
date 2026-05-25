import { useCallback, useEffect, useState } from "react";

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Charge une ressource async et expose data/loading/error + reload().
 * `fetcher` DOIT être stable (l'envelopper dans useCallback côté appelant).
 */
export function useResource<T>(fetcher: () => Promise<T>): ResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetcher()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.message ?? "Erreur"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [fetcher]);

  useEffect(() => load(), [load]);

  return { data, loading, error, reload: load };
}
