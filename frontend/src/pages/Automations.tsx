import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dot } from "@/components/ui/dot";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { AlarmClock, BellRing, Mail, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Automatisations PRÉVUES (interface anticipée — pas encore actives).
const AUTOMATIONS: { icon: LucideIcon; name: string; last: string }[] = [
  { icon: Mail, name: "Rapport hebdomadaire par email", last: "Envoi planifié (SMTP) au DSI" },
  { icon: BellRing, name: "Alertes anomalies", last: "Ticket « New » au-delà d'un seuil / SLA" },
  { icon: Trash2, name: "Purge des logs", last: "Rétention configurable du journal" },
  { icon: AlarmClock, name: "Re-synchronisation GLPI", last: "Rafraîchir le périmètre" },
];

export function Automations() {
  return (
    <>
      <PageHeader
        title="Automations"
        description="Tâches planifiées au-dessus du moteur. Aperçu des automatisations à venir."
      />
      <Card className="overflow-hidden">
        <PanelHead
          title="Automatisations"
          subtitle={`${AUTOMATIONS.length} prévues · 0 active`}
          right={
            <Button size="sm" disabled>
              + Nouvelle
            </Button>
          }
        />
        <div className="flex flex-col">
          {AUTOMATIONS.map((a) => (
            <div
              key={a.name}
              className="flex items-center justify-between gap-4 border-b border-border/50 px-4 py-3 last:border-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Dot tone="muted" />
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <a.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{a.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    Dernière exécution : —
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden text-[11px] text-muted-foreground sm:inline">{a.last}</span>
                <Tag tone="muted">Bientôt</Tag>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
