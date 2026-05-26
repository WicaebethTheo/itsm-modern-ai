import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { useT } from "@/lib/i18n";

// Catalogue d'extensions PRÉVU (interface anticipée — pas encore actif).
const RECIPES: { fr: string; en: string; descFr: string; descEn: string }[] = [
  {
    fr: "Rapport hebdomadaire",
    en: "Weekly report",
    descFr: "Email automatique du bilan de triage de la semaine (volume, couverture, coût).",
    descEn: "Automatic weekly triage summary email (volume, coverage, cost).",
  },
  {
    fr: "Masquage avancé (NER)",
    en: "Advanced masking (NER)",
    descFr: "Masque noms et adresses en plus des regex (reconnaissance d'entités).",
    descEn: "Masks names and addresses on top of regexes (entity recognition).",
  },
  {
    fr: "Détection de doublons",
    en: "Duplicate detection",
    descFr: "Regroupe les tickets similaires / incidents de masse avant triage.",
    descEn: "Groups similar tickets / mass incidents before triage.",
  },
  {
    fr: "Connecteurs LLM additionnels",
    en: "Additional LLM connectors",
    descFr: "Gemini, OVH, Scaleway, vLLM… au-delà de Mistral / OpenAI / Ollama / Anthropic.",
    descEn: "Gemini, OVH, Scaleway, vLLM… beyond Mistral / OpenAI / Ollama / Anthropic.",
  },
];

export function Store() {
  const t = useT();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {RECIPES.map((r) => (
        <Card key={r.en} className="flex flex-col p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium">{t(r.fr, r.en)}</span>
            <Tag tone="muted">{t("Bientôt", "Soon")}</Tag>
          </div>
          <div className="mt-1 mb-3 flex-1 text-[12px] leading-relaxed text-muted-foreground">
            {t(r.descFr, r.descEn)}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">{t("Aperçu", "Preview")}</span>
            <Button size="sm" variant="outline" disabled>
              {t("Installer", "Install")}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
