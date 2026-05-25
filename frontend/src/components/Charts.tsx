import { cn } from "@/lib/utils";

/** Mini barres (sparkline) — tendance compacte dans une carte KPI. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className={cn("flex h-5 items-end gap-0.5", className)} aria-hidden>
      {values.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: série de longueur fixe, ordre stable
          key={i}
          className="flex-1 rounded-sm bg-primary/40"
          style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** Barre de progression horizontale (carte « Confiance moyenne »). */
export function ProgressBar({ ratio }: { ratio: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary"
        style={{ width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` }}
      />
    </div>
  );
}

/** Barchart vertical empilé : déposées (foncé) vs « à trier » (clair) par jour. */
export function StackedBars({
  data,
}: {
  data: { date?: string; accepted: number; a_trier: number }[];
}) {
  const max = Math.max(1, ...data.map((d) => d.accepted + d.a_trier));
  return (
    <div className="flex h-[200px] items-end gap-1.5">
      {data.map((d, i) => {
        const total = d.accepted + d.a_trier;
        const barH = (total / max) * 100;
        const accH = total ? (d.accepted / total) * 100 : 0;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 14 jours, ordre stable
            key={i}
            className="group flex flex-1 flex-col justify-end"
            title={`${d.date} · ${d.accepted} déposées / ${d.a_trier} à trier`}
          >
            <div
              className="flex w-full flex-col overflow-hidden rounded-t-md"
              style={{ height: `${barH}%` }}
            >
              <div className="w-full bg-primary/35" style={{ height: `${100 - accH}%` }} />
              <div className="w-full bg-primary" style={{ height: `${accH}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
