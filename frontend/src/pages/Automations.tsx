import { useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dot } from "@/components/ui/dot";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, type RetentionView } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n";

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

/** Squelette aux dimensions de la carte finale : évite le saut de mise en page au chargement. */
function PurgeSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex items-center gap-3">
        <span className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-muted" />
        <div className="flex flex-col gap-1.5">
          <span className="h-3 w-48 animate-pulse rounded bg-muted" />
          <span className="h-2.5 w-64 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <span className="h-3 w-32 animate-pulse rounded bg-muted" />
            <span className="h-8 w-full animate-pulse rounded-md bg-muted" />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="h-2.5 w-56 animate-pulse rounded bg-muted" />
        <span className="h-8 w-40 animate-pulse rounded-md bg-muted" />
      </div>
    </div>
  );
}

function PurgeCard({ data, reload }: { data: RetentionView; reload: () => void }) {
  const t = useT();
  const locale = useLocale();
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

  /**
   * Fenêtre telle qu'elle sera RÉELLEMENT appliquée. 0 n'est pas « plus de 0 jour »
   * (ce qui annoncerait la suppression de TOUT) : le moteur traite 0 comme « ne pas
   * purger », exactement ce que dit l'indication sous le champ.
   */
  const windowLabel = (days: number) =>
    days > 0 ? t(`au-delà de ${days} j`, `beyond ${days} d`) : t("non purgé (0)", "not purged (0)");

  async function runNow() {
    // Confirmation explicite : action destructive irréversible (RGPD), incohérent sans
    // garde-fou. Elle annonce les valeurs PERSISTÉES (`data`) et jamais le brouillon —
    // c'est ce que le serveur appliquera. Le brouillon divergent est SIGNALÉ, pas utilisé.
    const nothing = data.decisions_days === 0 && data.llm_calls_days === 0;
    const lines = [
      t(
        `Journal des décisions : ${windowLabel(data.decisions_days)}`,
        `Decision journal: ${windowLabel(data.decisions_days)}`,
      ),
      t(
        `Appels LLM : ${windowLabel(data.llm_calls_days)}`,
        `LLM calls: ${windowLabel(data.llm_calls_days)}`,
      ),
      nothing
        ? t(
            "Aucune fenêtre de rétention active : la purge ne supprimera rien.",
            "No retention window is active: the purge will delete nothing.",
          )
        : t(
            "Les lignes plus anciennes seront supprimées définitivement.",
            "Older rows will be permanently deleted.",
          ),
    ];
    if (dirty) {
      lines.push(
        t(
          "Attention : des modifications non enregistrées sont à l'écran ; la purge applique les valeurs ci-dessus, pas celles saisies.",
          "Warning: unsaved changes are on screen; the purge applies the values above, not the ones you typed.",
        ),
      );
    }
    const ok = window.confirm(
      `${t("Exécuter la purge maintenant ?", "Run the purge now?")}\n\n${lines.join("\n")}`,
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
    ? new Date(data.last_run_at).toLocaleString(locale, {
        dateStyle: "short",
        timeStyle: "short",
      })
    : t("jamais", "never");

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
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
        <Field
          label={t("Rétention Journal (jours)", "Journal retention (days)")}
          hint={t("0 = ne pas purger.", "0 = do not purge.")}
        >
          <Input
            id="dec-days"
            type="number"
            min={0}
            max={3650}
            value={draft.decisions_days}
            onChange={(e) => setDraft({ ...draft, decisions_days: Number(e.target.value) || 0 })}
            className="h-8"
          />
        </Field>
        <Field
          label={t("Rétention appels LLM (jours)", "LLM calls retention (days)")}
          hint={t("0 = ne pas purger.", "0 = do not purge.")}
        >
          <Input
            id="llm-days"
            type="number"
            min={0}
            max={3650}
            value={draft.llm_calls_days}
            onChange={(e) => setDraft({ ...draft, llm_calls_days: Number(e.target.value) || 0 })}
            className="h-8"
          />
        </Field>
        <Field label={t("Heure d'exécution (UTC)", "Run hour (UTC)")}>
          <Input
            id="hour"
            type="number"
            min={0}
            max={23}
            value={draft.hour_utc}
            onChange={(e) => setDraft({ ...draft, hour_utc: Number(e.target.value) || 0 })}
            className="h-8"
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <div className="text-caption text-muted-foreground">
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
          {/* Le bouton d'à côté n'applique PAS ce qui est à l'écran : le dire avant le clic,
              pas seulement dans la confirmation qu'on lit en diagonale. */}
          {dirty && (
            <div className="text-warning">
              {t(
                "Modifications non enregistrées : « Exécuter maintenant » applique les valeurs enregistrées, pas celles affichées.",
                "Unsaved changes: “Run now” applies the saved values, not the ones displayed.",
              )}
            </div>
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
        {retention.loading && <PurgeSkeleton />}
        {retention.error && (
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <Banner kind="error" role="alert">
              {retention.error}
            </Banner>
            {/* `useResource` sait recharger : sans ce bouton, la seule issue était F5. */}
            <Button size="sm" variant="outline" onClick={retention.reload}>
              {t("Réessayer", "Retry")}
            </Button>
          </div>
        )}
        {retention.data && <PurgeCard data={retention.data} reload={retention.reload} />}
      </Card>

      <Card className="overflow-hidden">
        <PanelHead
          title={t("Automatisations à venir", "Upcoming automations")}
          // Le sous-titre décrit CETTE carte : elle ne contient que des automatisations
          // non encore livrées. Compter la purge ici (« 4 prévues · 1 active ») annonçait
          // une ligne de plus que ce qu'on liste, et rendait « active » introuvable.
          subtitle={t(
            `${PLANNED.length} automatisations prévues, aucune encore disponible`,
            `${PLANNED.length} planned automations, none available yet`,
          )}
          right={<Tag tone="muted">{t("Feuille de route", "Roadmap")}</Tag>}
        />
        <div>
          {PLANNED.map((a, i, arr) => (
            <div
              key={a.en}
              className={`flex items-center gap-3 px-5 py-3 ${i < arr.length - 1 ? "border-b border-border" : ""}`}
            >
              <Dot tone="muted" />
              <div className="min-w-0 flex-1">
                <div className="text-ui font-medium">{t(a.fr, a.en)}</div>
                {/* « Dernière exécution : — » pour un job qui n'existe pas se lit comme un
                    job cassé. La description dit ce que l'automatisation FERA. Toujours
                    visible : masquée sous 640 px, la liste se réduisait à trois titres. */}
                <div className="text-caption text-muted-foreground">{t(a.descFr, a.descEn)}</div>
              </div>
              <Tag tone="muted">{t("Bientôt", "Soon")}</Tag>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
