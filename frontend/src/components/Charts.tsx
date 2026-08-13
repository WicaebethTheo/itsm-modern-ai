import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Sparkline en mini-barres (carte KPI) — style maquette `.spark`.
 *
 * Le plancher de hauteur ne s'applique QU'AUX valeurs non nulles : appliqué à tout, il
 * peignait une barre pour un jour à zéro, visuellement indiscernable d'un jour à un
 * ticket. Un zéro ne peint rien — l'emplacement reste réservé (le `span` est rendu), donc
 * l'axe des jours ne bouge pas.
 */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className={cn("spark mt-2", className)} aria-hidden>
      {values.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: série de longueur fixe, ordre stable
          key={i}
          style={{ height: v > 0 ? `${Math.max(8, (v / max) * 100)}%` : 0 }}
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
 *
 * `role="progressbar"` + valeurs ARIA (même recette que la jauge de plafond de
 * CostQuotas) : une jauge peinte sans nom accessible ne dit rien à un lecteur d'écran, et
 * une jauge peinte à 0 % sur une valeur INCONNUE ment à tout le monde — d'où le nom
 * OBLIGATOIRE, qui force l'appelant à dire ce qu'il mesure.
 */
export function ProgressBar({
  ratio,
  label,
  tone = "primary",
  className,
}: {
  ratio: number;
  label: string;
  tone?: ProgressTone;
  className?: string;
}) {
  // `ratio` peut arriver en NaN (division par un plafond nul) : on ne peint pas « NaN% ».
  const pct = Number.isFinite(ratio) ? Math.round(Math.min(1, Math.max(0, ratio)) * 100) : 0;
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div
        className={cn("h-full rounded-full", PROGRESS_TONE[tone])}
        style={{ width: `${pct}%` }}
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
