import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Check, KeyRound, Lock } from "lucide-react";
import { useState } from "react";

type Edition = "community" | "enterprise";

// Catalogue de modules (vitrine open-core — pas encore actif côté serveur).
// `community` = inclus dans l'édition libre ; `enterprise` = débloqué par licence.
const MODULES: { fr: string; en: string; descFr: string; descEn: string; edition: Edition }[] = [
  {
    fr: "Multi-fournisseurs LLM",
    en: "Multi LLM providers",
    descFr: "Mistral EU, OpenAI, Ollama (local), Anthropic — clés chiffrées au repos.",
    descEn: "Mistral EU, OpenAI, Ollama (local), Anthropic — keys encrypted at rest.",
    edition: "community",
  },
  {
    fr: "Journal & export DPO",
    en: "Journal & DPO export",
    descFr: "Journal des décisions annotable + export CSV (décisions, appels LLM).",
    descEn: "Annotatable decision journal + CSV export (decisions, LLM calls).",
    edition: "community",
  },
  {
    fr: "Masquage avancé (NER)",
    en: "Advanced masking (NER)",
    descFr: "Masque noms et adresses en plus des regex (reconnaissance d'entités).",
    descEn: "Masks names and addresses on top of regexes (entity recognition).",
    edition: "enterprise",
  },
  {
    fr: "Détection de doublons",
    en: "Duplicate detection",
    descFr: "Regroupe les tickets similaires / incidents de masse avant triage.",
    descEn: "Groups similar tickets / mass incidents before triage.",
    edition: "enterprise",
  },
  {
    fr: "Connecteurs LLM additionnels",
    en: "Additional LLM connectors",
    descFr: "Gemini, OVH, Scaleway, vLLM… au-delà des 4 fournisseurs inclus.",
    descEn: "Gemini, OVH, Scaleway, vLLM… beyond the 4 bundled providers.",
    edition: "enterprise",
  },
  {
    fr: "Connecteurs ITSM additionnels",
    en: "Additional ITSM connectors",
    descFr: "Au-delà de GLPI : autres outils de ticketing (extensions).",
    descEn: "Beyond GLPI: other ticketing tools (extensions).",
    edition: "enterprise",
  },
];

const FILTERS: { value: "all" | Edition; fr: string; en: string }[] = [
  { value: "all", fr: "Tout", en: "All" },
  { value: "community", fr: "Communauté", en: "Community" },
  { value: "enterprise", fr: "Entreprise", en: "Enterprise" },
];

export function Store() {
  const t = useT();
  const [filter, setFilter] = useState<"all" | Edition>("all");
  const [license, setLicense] = useState("");
  const [notice, setNotice] = useState(false);

  const shown = MODULES.filter((m) => filter === "all" || m.edition === filter);

  return (
    <div className="space-y-4">
      {/* Licence : déblocage de l'édition entreprise (hors-ligne, souverain). */}
      <Card>
        <PanelHead
          title={t("Licence", "License")}
          subtitle={t(
            "L'édition entreprise se débloque avec une clé — hors-ligne, aucune donnée ne sort.",
            "The enterprise edition unlocks with a key — offline, no data leaves.",
          )}
          right={
            <Tag tone="muted">
              <Check className="h-3 w-3" />
              {t("Édition Communauté", "Community edition")}
            </Tag>
          }
        />
        <CardContent className="flex flex-col gap-3 p-5">
          {notice && (
            <Banner kind="info">
              {t(
                "La version entreprise arrive — la validation de licence sera disponible bientôt.",
                "The enterprise version is coming — license validation will be available soon.",
              )}
            </Banner>
          )}
          <div className="flex items-end gap-2">
            <div className="relative flex-1">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={license}
                placeholder={t("Coller la clé de licence…", "Paste the license key…")}
                className="pl-9 font-mono"
                onChange={(e) => setLicense(e.target.value)}
              />
            </div>
            <Button onClick={() => setNotice(true)}>{t("Activer", "Activate")}</Button>
          </div>
        </CardContent>
      </Card>

      {/* Filtre Communauté / Entreprise. */}
      <div className="inline-flex items-center gap-1 rounded-md border border-border bg-card p-1 text-[12.5px]">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded px-3 py-1 transition-colors",
              filter === f.value
                ? "bg-primary/15 text-accent-indigo"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t(f.fr, f.en)}
          </button>
        ))}
      </div>

      {/* Catalogue. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {shown.map((m) => {
          const pro = m.edition === "enterprise";
          return (
            <Card key={m.en} className="flex flex-col p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{t(m.fr, m.en)}</span>
                {pro ? (
                  <Tag tone="indigo">Entreprise</Tag>
                ) : (
                  <Tag tone="green">
                    <Check className="h-3 w-3" />
                    {t("Inclus", "Included")}
                  </Tag>
                )}
              </div>
              <div className="mt-1 mb-3 flex-1 text-[12px] leading-relaxed text-muted-foreground">
                {t(m.descFr, m.descEn)}
              </div>
              <div className="flex items-center justify-end">
                {pro ? (
                  <Button size="sm" variant="outline" disabled>
                    <Lock className="h-3.5 w-3.5" />
                    {t("Licence requise", "License required")}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled>
                    <Check className="h-3.5 w-3.5" />
                    {t("Actif", "Active")}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
