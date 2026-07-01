import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Sparkline en mini-barres (carte KPI) — style maquette `.spark`. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className={cn("spark mt-2", className)} aria-hidden>
      {values.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: série de longueur fixe, ordre stable
          key={i}
          style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** Barre de progression horizontale (carte « Confiance moyenne ») — dégradé indigo. */
export function ProgressBar({ ratio }: { ratio: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`,
          background: "linear-gradient(90deg,#6366f1,#8b8df7)",
        }}
      />
    </div>
  );
}

/**
 * Barchart vertical empilé (tendance) — style maquette : `.bar` (déposées, dégradé
 * indigo plein) + `.bar.dim` (à trier, atténué). Hauteurs proportionnelles au max.
 */
export function StackedBars({
  data,
  height = 120,
}: {
  data: { date?: string; accepted: number; a_trier: number }[];
  height?: number;
}) {
  const t = useT();
  const max = Math.max(1, ...data.map((d) => d.accepted + d.a_trier));
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {data.map((d, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 14 jours, ordre stable
          key={i}
          className="flex flex-1 flex-col justify-end gap-px"
          // Infobulle bilingue (l'UI est FR/EN, pas seulement FR).
          title={`${d.date ?? ""} · ${d.accepted} ${t("traités", "handled")} / ${d.a_trier} ${t("à trier", "to triage")}`}
        >
          <div className="bar dim" style={{ height: (d.a_trier / max) * height }} />
          <div className="bar" style={{ height: (d.accepted / max) * height }} />
        </div>
      ))}
    </div>
  );
}
