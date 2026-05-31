/** Logo « nœud de décision » (cohérent avec le favicon) : une entrée se ramifie, la
 *  branche décidée est mise en avant avec une coche — « le LLM propose, le code décide ».
 *  Branche écartée en `currentColor` atténué → s'adapte au thème clair/sombre. */
export function Logo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      role="img"
      aria-label="ITSM Modern AI"
      fill="none"
    >
      {/* Arête écartée (gauche, atténuée) puis arête décidée (droite, accent). */}
      <path
        d="M20 12 L12.5 27"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.35"
      />
      <path d="M20 12 L27.5 27" stroke="#6366f1" strokeWidth="2.8" strokeLinecap="round" />
      {/* Nœud d'entrée. */}
      <circle cx="20" cy="10" r="3.6" className="logo-grad-a" />
      {/* Branche écartée. */}
      <circle cx="12" cy="28.5" r="3.2" fill="currentColor" opacity="0.35" />
      {/* Branche décidée + coche. */}
      <circle cx="27.5" cy="28.5" r="5.2" className="logo-grad-b" />
      <path
        d="M25 28.7 L26.9 30.7 L30.2 26.4"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
