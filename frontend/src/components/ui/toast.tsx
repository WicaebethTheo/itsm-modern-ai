/**
 * Toast — notifications éphémères en bas-droite (feedback de sauvegarde, erreurs).
 *
 * `useToast()` retourne `{ success, error, info }` — appelle-les depuis n'importe
 * quelle page protégée. Provider injecté une fois dans App.tsx ; chaque toast vit
 * 3 s (6 s pour les erreurs) puis disparaît. Cliquer dessus le ferme tout de suite.
 */

import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type ToastKind = "success" | "error" | "info";

interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const NOOP: ToastApi = { success: () => {}, error: () => {}, info: () => {} };

/**
 * Toujours sûr à appeler : si on est rendu hors `<ToastProvider>` (typiquement en
 * tests unitaires de page), les appels sont des no-op silencieux plutôt que de
 * crasher le composant. Le Provider est posé une fois dans App.tsx (cf. arbre prod).
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

const STYLES: Record<ToastKind, { wrap: string; icon: ReactNode }> = {
  success: {
    wrap: "border-success/40 bg-success/10 text-success",
    icon: <CheckCircle2 className="h-4 w-4" />,
  },
  error: {
    wrap: "border-destructive/40 bg-destructive/10 text-destructive",
    icon: <XCircle className="h-4 w-4" />,
  },
  info: {
    wrap: "border-primary/30 bg-primary/10 text-primary",
    icon: <Info className="h-4 w-4" />,
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message }]);
    // Auto-dismiss : 3 s pour succès/info, 6 s pour les erreurs (le temps de lire
    // un message d'échec avant qu'il ne disparaisse).
    const ttl = kind === "error" ? 6000 : 3000;
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ttl);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      info: (m) => push("info", m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onClose={remove} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toasts,
  onClose,
}: {
  toasts: ToastEntry[];
  onClose: (id: number) => void;
}) {
  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} onClose={() => onClose(t.id)} />
      ))}
    </section>
  );
}

function ToastItem({ entry, onClose }: { entry: ToastEntry; onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  const t = useT();
  useEffect(() => {
    // Tick d'animation à l'arrivée (slide-in).
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const s = STYLES[entry.kind];
  return (
    <div
      role={entry.kind === "error" ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex items-start gap-2.5 rounded-md border px-3 py-2 text-[12.5px] shadow-lg backdrop-blur-sm transition-all duration-150",
        s.wrap,
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
    >
      <span className="mt-0.5 shrink-0">{s.icon}</span>
      <span className="flex-1 leading-snug">{entry.message}</span>
      <button
        type="button"
        aria-label={t("Fermer", "Close")}
        onClick={onClose}
        className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
