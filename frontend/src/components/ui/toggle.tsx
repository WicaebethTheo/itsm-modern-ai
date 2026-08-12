import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Toggle — interrupteur (spec Operator Preview) : piste w-10 h-5.5, ON = indigo,
 * knob blanc qui translate. Optionnellement précédé d'un label + description (ligne complète).
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const knob = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? id : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "h-4 w-4 rounded-full bg-white transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0",
        )}
      />
    </button>
  );

  if (!label) return knob;

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p id={id} className="text-ui font-medium">
          {label}
        </p>
        {description && (
          <p className="mt-0.5 text-caption leading-snug text-muted-foreground">{description}</p>
        )}
      </div>
      {knob}
    </div>
  );
}
