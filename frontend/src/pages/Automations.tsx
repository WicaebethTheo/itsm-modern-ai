import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dot } from "@/components/ui/dot";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, type RetentionView } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";

// Automatisations PRÉVUES — seule la purge est active aujourd'hui.
const PLANNED: { fr: string; en: string; descFr: string; descEn: string }[] = [
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
    fr: "Re-synchronisation GLPI",
    en: "GLPI re-sync",
    descFr: "Rafraîchir périodiquement le périmètre",
    descEn: "Periodically refresh the scope",
  },
];

function PurgeCard({ data, reload }: { data: RetentionView; reload: () => void }) {
  const t = useT();
  const toast = useToast();
  const [draft, setDraft] = useState<RetentionView>(data);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => setDraft(data), [data]);

  const dirty =
    draft.enabled !== data.enabled ||
    draft.decisions_days !== data.decisions_days ||
    draft.llm_calls_days !== data.llm_calls_days ||
    draft.hour_utc !== data.hour_utc;

  async function save() {
    setSaving(true);
    try {
      await Api.updateRetention({
        enabled: draft.enabled,
        decisions_days: draft.decisions_days,
        llm_calls_days: draft.llm_calls_days,
        hour_utc: draft.hour_utc,
      });
      reload();
      toast.success(t("Réglages enregistrés.", "Settings saved."));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    // Confirmation explicite : action destructive irréversible (RGPD), incohérent sans garde-fou.
    const ok = window.confirm(
      t(
        `Supprimer définitivement les décisions de plus de ${data.decisions_days} j et les appels LLM de plus de ${data.llm_calls_days} j ?`,
        `Permanently delete decisions older than ${data.decisions_days} d and LLM calls older than ${data.llm_calls_days} d?`,
      ),
    );
    if (!ok) return;
    setRunning(true);
    try {
      const r = await Api.runRetention();
      reload();
      toast.success(
        t(
          `Purge exécutée : ${r.decisions_deleted} décision(s), ${r.llm_calls_deleted} appel(s) LLM supprimés.`,
          `Purge ran: ${r.decisions_deleted} decision(s), ${r.llm_calls_deleted} LLM call(s) deleted.`,
        ),
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const last = data.last_run_at
    ? new Date(data.last_run_at).toLocaleString(t("fr-FR", "en-US"), {
        dateStyle: "short",
        timeStyle: "short",
      })
    : t("jamais", "never");

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <Toggle
        checked={draft.enabled}
        onChange={(v) => setDraft({ ...draft, enabled: v })}
        label={t("Purge automatique activée", "Automatic purge enabled")}
        description={t(
          "Le job tourne quotidiennement à l'heure UTC choisie.",
          "Job runs daily at the chosen UTC hour.",
        )}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="dec-days">
            {t("Rétention Journal (jours)", "Journal retention (days)")}
          </Label>
          <Input
            id="dec-days"
            type="number"
            min={0}
            max={3650}
            value={draft.decisions_days}
            onChange={(e) => setDraft({ ...draft, decisions_days: Number(e.target.value) || 0 })}
            className="h-8"
          />
          <p className="mt-1 text-[10.5px] text-muted-foreground">
            {t("0 = ne pas purger.", "0 = do not purge.")}
          </p>
        </div>
        <div>
          <Label htmlFor="llm-days">
            {t("Rétention appels LLM (jours)", "LLM calls retention (days)")}
          </Label>
          <Input
            id="llm-days"
            type="number"
            min={0}
            max={3650}
            value={draft.llm_calls_days}
            onChange={(e) => setDraft({ ...draft, llm_calls_days: Number(e.target.value) || 0 })}
            className="h-8"
          />
          <p className="mt-1 text-[10.5px] text-muted-foreground">
            {t("0 = ne pas purger.", "0 = do not purge.")}
          </p>
        </div>
        <div>
          <Label htmlFor="hour">{t("Heure d'exécution (UTC)", "Run hour (UTC)")}</Label>
          <Input
            id="hour"
            type="number"
            min={0}
            max={23}
            value={draft.hour_utc}
            onChange={(e) => setDraft({ ...draft, hour_utc: Number(e.target.value) || 0 })}
            className="h-8"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <div className="text-[11px] text-muted-foreground">
          {t("Dernière exécution :", "Last run:")} {last}
          {data.last_decisions_deleted !== null && (
            <>
              {" · "}
              {t(
                `${data.last_decisions_deleted} décision(s), ${data.last_llm_calls_deleted ?? 0} LLM`,
                `${data.last_decisions_deleted} decision(s), ${data.last_llm_calls_deleted ?? 0} LLM`,
              )}
            </>
          )}
          {data.last_run_by && (
            <>
              {" · "}
              {t(`par ${data.last_run_by}`, `by ${data.last_run_by}`)}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={runNow} disabled={running}>
            {running ? t("Purge…", "Purging…") : t("Exécuter maintenant", "Run now")}
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? t("Enregistrement…", "Saving…") : t("Enregistrer", "Save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Automations() {
  const t = useT();
  const retention = useResource(useCallback(() => Api.retention(), []));
  // « Active » = purge réellement activée, pas simplement la ressource chargée.
  const activeCount = retention.data?.enabled ? 1 : 0;
  const total = 1 + PLANNED.length;

  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        <PanelHead
          title={t("Purge des logs", "Log purge")}
          subtitle={t(
            "Rétention RGPD du Journal des décisions et des appels LLM.",
            "GDPR retention of the decision journal and LLM calls.",
          )}
          right={
            retention.data?.enabled ? (
              <Tag tone="green">{t("Active", "Active")}</Tag>
            ) : (
              <Tag tone="muted">{t("Désactivée", "Disabled")}</Tag>
            )
          }
        />
        {retention.loading && (
          <p className="p-6 text-[12.5px] text-muted-foreground">{t("Chargement…", "Loading…")}</p>
        )}
        {retention.error && <p className="p-6 text-[12.5px] text-destructive">{retention.error}</p>}
        {retention.data && <PurgeCard data={retention.data} reload={retention.reload} />}
      </Card>

      <Card className="overflow-hidden">
        <PanelHead
          title={t("Automatisations", "Automations")}
          subtitle={t(
            `${total} prévues · ${activeCount} active`,
            `${total} planned · ${activeCount} active`,
          )}
          right={
            <Button size="sm" disabled>
              {t("+ Nouvelle", "+ New")}
            </Button>
          }
        />
        <div>
          {PLANNED.map((a, i, arr) => (
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
    </div>
  );
}
