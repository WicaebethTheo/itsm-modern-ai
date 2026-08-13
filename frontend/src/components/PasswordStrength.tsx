import { MIN_PASSWORD_CHARS } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { scorePassword } from "@/lib/password";
import { cn } from "@/lib/utils";

/**
 * Jauge de robustesse : quatre segments, un verdict, un conseil.
 *
 * TON : elle informe, elle ne culpabilise pas. Pas de rouge tant qu'il n'y a rien à
 * reprocher, pas de « mot de passe faible ! » en capitales, et surtout aucun effet sur
 * la possibilité d'envoyer le formulaire — le moteur accepte dès 8 caractères, l'UI ne
 * durcit pas cette règle (cf. lib/password.ts).
 *
 * ACCESSIBILITÉ : les segments sont décoratifs (`aria-hidden`) ; c'est le TEXTE qui porte
 * l'information, et il est annoncé en `aria-live="polite"` — un lecteur d'écran suit donc
 * la progression pendant la frappe, sans interrompre la saisie.
 *
 * `invalid` : le formulaire a refusé l'envoi pour cause de longueur. La jauge dit DÉJÀ ce
 * qui manque (« encore N caractères ») — on colore sa ligne plutôt que d'empiler un second
 * message rouge qui répéterait la même phrase deux lignes plus bas.
 */
export function PasswordStrength({
  password,
  id,
  invalid = false,
}: {
  password: string;
  id?: string;
  invalid?: boolean;
}) {
  const t = useT();
  const { score, longEnough, advice } = scorePassword(password);

  const labels = [
    t("très faible", "very weak"),
    t("faible", "weak"),
    t("correct", "fair"),
    t("solide", "strong"),
    t("excellent", "excellent"),
  ];
  // Progression froide → chaude, cohérente avec les tokens produit. Le premier palier
  // n'est PAS rouge destructif : rien n'est en erreur, c'est juste améliorable.
  const colors = [
    "bg-muted-foreground/40",
    "bg-warning",
    "bg-warning",
    "bg-accent-indigo",
    "bg-success",
  ];

  const advices: Record<NonNullable<typeof advice>, string> = {
    length: t(
      "Un mot de passe plus long est le gain le plus simple.",
      "Longer is the easiest win.",
    ),
    variety: t(
      "Mélanger majuscules, chiffres et ponctuation le renforce encore.",
      "Mixing capitals, digits and punctuation strengthens it further.",
    ),
    common: t(
      "Il contient un mot très courant : les dictionnaires l'essaient en premier.",
      "It contains a very common word: dictionaries try those first.",
    ),
    repetition: t(
      "Il répète un même motif : cela ne rallonge pas vraiment le mot de passe.",
      "It repeats a single pattern: that does not really make it longer.",
    ),
  };

  const filled = password ? score + 1 : 0;
  const missing = MIN_PASSWORD_CHARS - password.length;

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div className="flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              // Piste vide en `muted-foreground/20` et non `muted` : sur la carte BLANCHE
              // du thème clair, `muted` est presque la couleur du fond — la jauge y était
              // invisible tant qu'aucun segment n'était rempli (mesuré sur capture).
              i < filled ? colors[score] : "bg-muted-foreground/20",
            )}
          />
        ))}
      </div>
      <p
        id={id}
        aria-live="polite"
        className={cn(
          "text-body leading-snug",
          invalid ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {!password
          ? t(
              `${MIN_PASSWORD_CHARS} caractères minimum. Une phrase de passe fait très bien l'affaire.`,
              `${MIN_PASSWORD_CHARS} characters minimum. A passphrase works nicely.`,
            )
          : !longEnough
            ? t(
                `Encore ${missing} caractère${missing > 1 ? "s" : ""} pour atteindre le minimum.`,
                `${missing} more character${missing > 1 ? "s" : ""} to reach the minimum.`,
              )
            : `${t("Robustesse", "Strength")} : ${labels[score]}.${advice ? ` ${advices[advice]}` : ""}`}
      </p>
    </div>
  );
}
