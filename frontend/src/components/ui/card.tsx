import { cn } from "@/lib/utils";
import type * as React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Ajoute un retour visuel au survol (utile pour les cartes cliquables). */
  interactive?: boolean;
}

export function Card({ className, interactive, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground",
        interactive && "cursor-pointer transition-colors hover:border-primary/40",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-5 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-[13px] font-medium leading-none", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-3", className)} {...props} />;
}
