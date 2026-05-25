import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Bot, Copy, FileText, ShieldQuestion, Sparkles, Workflow } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Catalogue d'extensions/automatisations PRÉVU (interface anticipée — pas encore actif).
const CATALOG: { icon: LucideIcon; name: string; description: string; tag: string }[] = [
  {
    icon: FileText,
    name: "Rapport hebdomadaire",
    description: "Email automatique du bilan de triage de la semaine (volume, couverture, coût).",
    tag: "Automatisation",
  },
  {
    icon: ShieldQuestion,
    name: "Masquage avancé (NER)",
    description: "Masquage des noms et adresses en plus des regex (reconnaissance d'entités).",
    tag: "Confidentialité",
  },
  {
    icon: Copy,
    name: "Détection de doublons",
    description: "Regroupe les tickets similaires / incidents de masse avant triage.",
    tag: "Moteur",
  },
  {
    icon: Bot,
    name: "Connecteurs LLM additionnels",
    description: "Gemini, OVH, Scaleway, vLLM… au-delà de Mistral / OpenAI / Ollama / Anthropic.",
    tag: "Fournisseur",
  },
  {
    icon: Workflow,
    name: "Modes semi-auto / full-auto",
    description: "Au-delà du mode suggestion : application automatique sous conditions.",
    tag: "Moteur",
  },
  {
    icon: Sparkles,
    name: "Modules Enterprise",
    description: "Multi-entités, SSO SAML, audit log signé — pour les grandes organisations.",
    tag: "Enterprise",
  },
];

export function Store() {
  return (
    <>
      <PageHeader
        title="Store"
        description="Catalogue d'extensions et d'automatisations. Aperçu de l'offre à venir."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {CATALOG.map((it) => (
          <Card key={it.name} interactive>
            <CardContent className="flex flex-col gap-3 p-5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <it.icon className="h-5 w-5" />
                </span>
                <Badge variant="muted">Bientôt</Badge>
              </div>
              <div>
                <p className="font-semibold">{it.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{it.description}</p>
              </div>
              <span className="text-xs uppercase tracking-wide text-muted-foreground/70">
                {it.tag}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
