import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-ui font-medium transition-colors active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-muted text-foreground hover:bg-accent",
        outline: "border border-input bg-card hover:bg-accent hover:text-accent-foreground",
        ghost: "shadow-none hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-body",
        lg: "h-10 px-6",
        // Carrés : une seule géométrie pour tous les boutons-icône de la console.
        icon: "h-9 w-9 p-0",
        "icon-sm": "h-7 w-7 p-0 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

/** Tailles qui portent un libellé visible. */
type TextSize = "default" | "sm" | "lg";
/** Tailles carrées : le bouton ne contient qu'une icône, donc rien à lire. */
type IconSize = "icon" | "icon-sm";

type ButtonBase = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  variant?: ButtonVariant;
};

/**
 * `aria-label` est OBLIGATOIRE par typage sur les tailles d'icône : un carré de 28 px sans
 * nom accessible est un bouton muet pour un lecteur d'écran, et le compilateur est le seul
 * endroit où l'on peut refuser ça systématiquement.
 */
export type ButtonProps = ButtonBase &
  ({ size?: TextSize; "aria-label"?: string } | { size: IconSize; "aria-label": string });

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  ),
);
Button.displayName = "Button";
