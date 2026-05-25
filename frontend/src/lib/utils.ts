import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Fusion conditionnelle de classes Tailwind. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
