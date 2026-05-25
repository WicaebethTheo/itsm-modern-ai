import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AlarmClock, BellRing, Mail, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Automatisations PRÉVUES (interface anticipée — pas encore actives).
const AUTOMATIONS: { icon: LucideIcon; name: string; description: string }[] = [
  {
    icon: Mail,
    name: "Rapport hebdomadaire par email",
    description: "Envoi planifié (SMTP) du bilan de triage de la semaine au DSI.",
  },
  {
    icon: BellRing,
    name: "Alertes anomalies",
    description: "Notifier quand un ticket « New » dépasse un seuil d'ancienneté ou un SLA.",
  },
  {
    icon: Trash2,
    name: "Purge des logs",
    description: "Politique de rétention configurable du journal et des appels LLM.",
  },
  {
    icon: AlarmClock,
    name: "Re-synchronisation GLPI planifiée",
    description: "Rafraîchir périodiquement le périmètre (catégories, techniciens, groupes).",
  },
];

export function Automations() {
  return (
    <>
      <PageHeader
        title="Automations"
        description="Tâches planifiées au-dessus du moteur. Aperçu des automatisations à venir."
      />
      <div className="flex flex-col gap-3">
        {AUTOMATIONS.map((a) => (
          <Card key={a.name}>
            <CardContent className="flex items-center justify-between gap-4 p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <a.icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-medium">{a.name}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{a.description}</p>
                </div>
              </div>
              <Badge variant="muted">Bientôt</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
