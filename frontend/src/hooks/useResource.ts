import { tr } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";

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
  // Jeton de requête : deux reload() rapprochés peuvent se résoudre dans le
  // désordre — seule la réponse du chargement le plus récent écrit l'état.
  const seq = useRef(0);

  const load = useCallback(() => {
    const token = ++seq.current;
    const fresh = () => token === seq.current;
    setLoading(true);
    setError(null);
    fetcher()
      .then((d) => fresh() && setData(d))
      .catch((e) => fresh() && setError(e?.message ?? tr("Erreur", "Error")))
      .finally(() => fresh() && setLoading(false));
    return () => {
      // Invalide TOUT chargement en vol (unmount / fetcher changé) : un reload()
      // manuel lancé après l'effet a un token plus récent que celui capturé ici,
      // incrémenter inconditionnellement évite un setState après démontage.
      seq.current++;
    };
  }, [fetcher]);

  useEffect(() => load(), [load]);

  return { data, loading, error, reload: load };
}
