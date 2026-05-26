/** Logo bicolore (montagne « M » à deux versants), porté de la maquette. */
export function Logo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" role="img" aria-label="ITSM Modern AI">
      <path d="M4 32 L13 11 L20 22 Z" className="logo-grad-a" />
      <path d="M20 22 L27 11 L36 32 Z" className="logo-grad-b" />
      <path d="M4 32 L36 32" stroke="currentColor" strokeWidth="0.6" opacity="0.3" />
    </svg>
  );
}
