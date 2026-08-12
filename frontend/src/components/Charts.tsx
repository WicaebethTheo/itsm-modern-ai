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

/**
 * Ton d'une barre de progression. `warning`/`destructive` servent aux jauges qui
 * approchent ou dépassent une limite (plafond de coût) : la couleur DIT l'état, elle
 * n'est pas décorative.
 */
export type ProgressTone = "primary" | "warning" | "destructive";

const PROGRESS_TONE: Record<ProgressTone, string> = {
  primary: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

/**
 * Barre de progression horizontale. Couleur prise dans les tokens du thème (et non en
 * dur) : sans ça la jauge garde le même indigo en clair et en sombre, où le contraste
 * n'est pas le même.
 */
export function ProgressBar({
  ratio,
  tone = "primary",
  className,
}: {
  ratio: number;
  tone?: ProgressTone;
  className?: string;
}) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn("h-full rounded-full", PROGRESS_TONE[tone])}
        style={{ width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` }}
      />
    </div>
  );
}

/**
 * Barchart vertical empilé (tendance) : `.bar` = traités (primaire), `.bar.dim` = à trier
 * (ambre). Les deux séries sont peintes depuis les tokens de `index.css`, donc le couple
 * vert/ambre du reste de la console ne s'inverse pas d'un thème à l'autre.
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
