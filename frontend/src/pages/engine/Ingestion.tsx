import { Timer } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Toggle } from "@/components/ui/toggle";
import { useConfigDraft } from "@/hooks/useConfigDraft";
import { asBool, type ConfigUpdate, type ConfigView } from "@/lib/api";
import { tr, useT } from "@/lib/i18n";
import { ErreurDeLecture, HeadTitle, SaveBar } from "./shared";

interface Draft {
  actif: boolean;
  intervalle: string;
}

function toDraft(c: ConfigView | null): Draft {
  return {
    // Tant que la config n'est pas lue : défaut sûr (le moteur tourne).
    actif: c ? asBool(c.polling_enabled) : true,
    intervalle: c?.polling_interval_seconds ?? "",
  };
}

function toPayload(d: Draft): ConfigUpdate {
  const p: ConfigUpdate = { polling_enabled: d.actif };
  if (d.intervalle !== "") p.polling_interval_seconds = Number(d.intervalle);
  return p;
}

/**
 * L'ingestion : le moteur relève-t-il les nouveaux tickets, et à quelle cadence.
 *
 * C'est le seul réglage du produit appliqué IMMÉDIATEMENT — `routes/config.py` reprogramme
 * le job APScheduler à l'enregistrement. Le message de confirmation le dit, parce que tous
 * les autres écrans de réglage promettent l'inverse (« au prochain cycle ») et qu'une
 * promesse uniforme mais fausse vaut moins qu'une promesse exacte.
 */
export function Ingestion() {
  const t = useT();
  const cfg = useConfigDraft(
    toDraft,
    toPayload,
    tr(
      "Ingestion enregistrée. L'intervalle est appliqué immédiatement : le planificateur est reprogrammé.",
      "Ingestion saved. The interval applies immediately: the scheduler is rescheduled.",
    ),
  );
  const { draft, patch } = cfg;

  return (
    <div className="space-y-6">
      <ErreurDeLecture error={cfg.error} />
      <Card>
        <PanelHead
          title={
            <HeadTitle icon={<Timer />}>{t("Ingestion des tickets", "Ticket ingestion")}</HeadTitle>
          }
          subtitle={t(
            "Cadence de relevé des nouveaux tickets GLPI",
            "Sweep cadence for new GLPI tickets",
          )}
          right={
            <Tag tone={draft.actif ? "green" : "muted"}>
              {draft.actif ? t("Activé", "Enabled") : t("Désactivé", "Disabled")}
            </Tag>
          }
        />
        <CardContent className="flex flex-col gap-4">
          <Toggle
            checked={draft.actif}
            onChange={(v) => patch({ actif: v })}
            label={t("Polling activé", "Polling enabled")}
            description={t(
              "Le moteur traite les nouveaux tickets en continu.",
              "The engine processes new tickets continuously.",
            )}
          />
          <Field
            htmlFor="cfg-polling-interval"
            label={t("Intervalle de polling (secondes)", "Polling interval (seconds)")}
            hint={t(
              "Délai entre deux relevés des nouveaux tickets GLPI. Appliqué IMMÉDIATEMENT à l'enregistrement (le planificateur est reprogrammé), contrairement aux autres réglages du moteur.",
              "Delay between two sweeps of new GLPI tickets. Applied IMMEDIATELY on save (the scheduler is rescheduled), unlike the other engine settings.",
            )}
          >
            <Input
              id="cfg-polling-interval"
              type="number"
              min="10"
              value={draft.intervalle}
              placeholder="60"
              onChange={(e) => patch({ intervalle: e.target.value })}
            />
          </Field>
        </CardContent>
      </Card>

      <SaveBar
        dirty={cfg.dirty}
        saving={cfg.saving}
        peutEnregistrer={cfg.config !== null}
        onSave={() => cfg.save()}
      />
    </div>
  );
}
