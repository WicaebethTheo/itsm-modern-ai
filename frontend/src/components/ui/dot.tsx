import { cn } from "@/lib/utils";

export type DotTone = "green" | "indigo" | "amber" | "red" | "muted";

const toneClass: Record<DotTone, string> = {
  green: "bg-success",
  indigo: "bg-primary",
  amber: "bg-warning",
  red: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

/** Dot — pastille d'état 6px (spec Operator Preview). `pulse` pour un effet « live ». */
export function Dot({
  tone = "green",
  pulse = false,
  className,
}: {
  tone?: DotTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        toneClass[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}
