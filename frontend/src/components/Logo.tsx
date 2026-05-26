/** Logo « M » stylisé (montagne minimaliste) — couleur primaire (indigo). */
export function Logo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinejoin="round"
      strokeLinecap="round"
      role="img"
      aria-label="ITSM Modern AI"
    >
      <path d="M3 19 L8.5 6 L12 13 L15.5 6 L21 19" />
    </svg>
  );
}
