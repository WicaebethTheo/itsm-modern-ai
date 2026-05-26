import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dot } from "@/components/ui/dot";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useT } from "@/lib/i18n";

// Automatisations PRÉVUES (interface anticipée — pas encore actives).
const AUTOMATIONS: { fr: string; en: string; descFr: string; descEn: string }[] = [
  {
    fr: "Rapport hebdomadaire par email",
    en: "Weekly email report",
    descFr: "Envoi planifié (SMTP) du bilan de triage au DSI",
    descEn: "Scheduled (SMTP) triage summary to the IT manager",
  },
  {
    fr: "Alertes anomalies",
    en: "Anomaly alerts",
    descFr: "Ticket « New » au-delà d'un seuil d'ancienneté / SLA",
    descEn: "« New » ticket beyond an age / SLA threshold",
  },
  {
    fr: "Purge des logs",
    en: "Log purge",
    descFr: "Rétention configurable du journal et des appels LLM",
    descEn: "Configurable retention of the journal and LLM calls",
  },
  {
    fr: "Re-synchronisation GLPI",
    en: "GLPI re-sync",
    descFr: "Rafraîchir périodiquement le périmètre",
    descEn: "Periodically refresh the scope",
  },
];

export function Automations() {
  const t = useT();
  return (
    <Card className="overflow-hidden">
      <PanelHead
        title="Automations"
        subtitle={t(
          `${AUTOMATIONS.length} prévues · 0 active`,
          `${AUTOMATIONS.length} planned · 0 active`,
        )}
        right={
          <Button size="sm" disabled>
            {t("+ Nouvelle", "+ New")}
          </Button>
        }
      />
      <div>
        {AUTOMATIONS.map((a, i, arr) => (
          <div
            key={a.en}
            className={`flex items-center gap-3 px-4 py-3 ${i < arr.length - 1 ? "border-b border-border" : ""}`}
          >
            <Dot tone="muted" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{t(a.fr, a.en)}</div>
              <div className="text-[11px] text-muted-foreground">
                {t("Dernière exécution :", "Last run:")} —
              </div>
            </div>
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              {t(a.descFr, a.descEn)}
            </span>
            <Tag tone="muted">{t("Bientôt", "Soon")}</Tag>
          </div>
        ))}
      </div>
    </Card>
  );
}
