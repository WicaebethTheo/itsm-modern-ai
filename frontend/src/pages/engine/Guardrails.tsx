import { ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Banner } from "@/components/Banner";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { useConfigDraft } from "@/hooks/useConfigDraft";
import type { ConfigUpdate, ConfigView } from "@/lib/api";
import { tr, useT } from "@/lib/i18n";
import { ErreurDeLecture, HeadTitle, SaveBar } from "./shared";

const DEFAUTS = { confidence_threshold: "0.7", cost_cap_eur_per_day: "5", llm_retries: "1" };

interface Draft {
  confiance: string;
  plafond: string;
  retries: string;
}

/** Défini au niveau du module : `useConfigDraft` exige une projection STABLE. */
function toDraft(c: ConfigView | null): Draft {
  return {
    confiance: c?.confidence_threshold ?? "",
    plafond: c?.cost_cap_eur_per_day ?? "",
    retries: c?.llm_retries ?? "",
  };
}

/** Un champ vidé n'écrit rien : on ne remplace pas une borne par `0` parce qu'elle est vide. */
function toPayload(d: Draft): ConfigUpdate {
  const p: ConfigUpdate = {};
  if (d.confiance !== "") p.confidence_threshold = Number(d.confiance);
  if (d.plafond !== "") p.cost_cap_eur_per_day = Number(d.plafond);
  if (d.retries !== "") p.llm_retries = Number(d.retries);
  return p;
}

/**
 * Les trois bornes de sécurité du moteur — celles qui décident si une Décision est écrite
 * ou si le ticket part « à trier ». Elles sont seules sur leur écran parce que c'est la
 * question la plus lourde du produit, et qu'elle se posait jusqu'ici entre un réglage de
 * fenêtre de tableau de bord et un ton de réponse.
 */
export function Guardrails() {
  const t = useT();
  const cfg = useConfigDraft(
    toDraft,
    toPayload,
    tr(
      "Garde-fous enregistrés. Ils prennent effet au prochain cycle de traitement.",
      "Guardrails saved. They take effect on the next processing cycle.",
    ),
  );
  const { draft, patch } = cfg;

  // Seuil semi-auto EN VIGUEUR (celui du serveur) : il se règle sur l'écran « Modes ».
  // L'avertissement doit porter sur ce que le moteur applique, pas sur le brouillon d'un
  // autre écran — c'est la même règle que le miroir de `Modes.tsx`.
  const seuilSemi = cfg.config?.auto_min_confidence_default ?? "";
  const conf = Number(draft.confiance);
  const semi = Number(seuilSemi);
  const semiInerte =
    seuilSemi !== "" &&
    draft.confiance !== "" &&
    Number.isFinite(conf) &&
    Number.isFinite(semi) &&
    semi < conf;

  return (
    <div className="space-y-6">
      <ErreurDeLecture error={cfg.error} />
      <Card>
        <PanelHead
          title={<HeadTitle icon={<ShieldCheck />}>{t("Garde-fous", "Guardrails")}</HeadTitle>}
          subtitle={t(
            "Bornes de sécurité appliquées à chaque traitement",
            "Safety bounds applied to every run",
          )}
        />
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            htmlFor="cfg-confidence"
            label={t("Seuil de confiance (0 – 1)", "Confidence threshold (0 – 1)")}
            hint={t(
              "Barrière d'entrée du moteur : en dessous, AUCUNE écriture — le ticket part « à trier » avec un Suivi privé « non tranché ». Repères : 0,5 permissif · 0,7 équilibré · 0,9 strict.",
              "The engine's entry barrier: below it, NO write — the ticket goes “to triage” with a private “undecided” follow-up. Guides: 0.5 permissive · 0.7 balanced · 0.9 strict.",
            )}
          >
            <Input
              id="cfg-confidence"
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={draft.confiance}
              placeholder={DEFAUTS.confidence_threshold}
              onChange={(e) => patch({ confiance: e.target.value })}
            />
          </Field>
          <Field
            htmlFor="cfg-cost-cap"
            label={t("Plafond de coût (€/jour)", "Cost ceiling (€/day)")}
            hint={
              <>
                {t(
                  "Atteint, le moteur suspend les appels LLM facturables : tous les nouveaux tickets partent « à trier » jusqu'à la reprise de la fenêtre glissante de 24 h. 0 = pas de plafond, dépense non bornée.",
                  "Once reached, the engine pauses billable LLM calls: every new ticket goes “to triage” until the rolling 24h window frees up. 0 = no cap, unbounded spend.",
                )}{" "}
                <Link className="underline underline-offset-2 hover:text-foreground" to="/cost">
                  {t("Voir la consommation", "View consumption")}
                </Link>
              </>
            }
          >
            <Input
              id="cfg-cost-cap"
              type="number"
              step="0.5"
              min="0"
              value={draft.plafond}
              placeholder={DEFAUTS.cost_cap_eur_per_day}
              onChange={(e) => patch({ plafond: e.target.value })}
            />
          </Field>
          <Field
            htmlFor="cfg-retries"
            label={t("Tentatives LLM (retries)", "LLM retries")}
            hint={t(
              "Nouvelles tentatives quand le LLM répond hors format. Épuisées, le ticket part « à trier ».",
              "Retries when the LLM answers off-format. Once exhausted, the ticket goes “to triage”.",
            )}
          >
            <Input
              id="cfg-retries"
              type="number"
              min="0"
              max="5"
              value={draft.retries}
              placeholder={DEFAUTS.llm_retries}
              onChange={(e) => patch({ retries: e.target.value })}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Miroir de l'avertissement de « Modes d'exécution ».
          Sur l'ancienne page, les deux seuils voisinaient : le bandeau apparaissait à la
          frappe, quel que soit celui des deux qu'on bougeait. Séparés, l'avertissement n'a
          survécu que dans un sens — et c'est la direction la MOINS dangereuse qui a été
          conservée. Monter le seuil de confiance au-dessus du seuil semi-auto rend ce
          dernier inerte : `engine.evaluate()` a déjà renvoyé « à trier » avant que le mode
          ne soit consulté. L'exploitant réduit donc l'automatisation qu'il croit avoir
          réglée, sans qu'aucun écran ne le lui dise. */}
      {semiInerte && (
        <Banner kind="warning" role="status">
          {t(
            `Le seuil de confiance saisi (${draft.confiance}) dépasse le seuil semi-auto en vigueur (${seuilSemi}) : ce dernier n'aura plus aucun effet, la barrière d'entrée tranchera avant lui.`,
            `The confidence threshold entered (${draft.confiance}) exceeds the enforced semi-auto threshold (${seuilSemi}): the latter will have no effect, the entry barrier decides first.`,
          )}{" "}
          <Link className="underline underline-offset-2 hover:text-foreground" to="/engine/modes">
            {t("Régler les modes d'exécution", "Adjust the execution modes")}
          </Link>
        </Banner>
      )}

      <SaveBar
        dirty={cfg.dirty}
        saving={cfg.saving}
        peutEnregistrer={cfg.config !== null}
        onSave={() => cfg.save()}
      />
    </div>
  );
}
