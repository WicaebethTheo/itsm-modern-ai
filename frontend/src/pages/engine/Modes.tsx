import { ShieldHalf } from "lucide-react";
import { Link } from "react-router-dom";
import { Banner } from "@/components/Banner";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { Tag, type TagTone } from "@/components/ui/tag";
import { useConfigDraft } from "@/hooks/useConfigDraft";
import type { ConfigUpdate, ConfigView, ExecutionMode } from "@/lib/api";
import { tr, useT } from "@/lib/i18n";
import { ErreurDeLecture, HeadTitle, SaveBar } from "./shared";

/**
 * Couleur du marqueur de mode : neutre → amber → rouge selon l'autonomie accordée.
 * Table RECOPIÉE de `pages/Scope.tsx` (et non importée : une page n'est pas un module
 * partagé) — les deux vues règlent le même réglage, elles doivent en donner la même
 * lecture visuelle.
 */
const MODE_TONE: Record<ExecutionMode, TagTone> = {
  suggestion: "muted",
  semi_auto: "amber",
  full_auto: "red",
};

interface Draft {
  mode: ExecutionMode;
  seuilSemi: string;
}

function toDraft(c: ConfigView | null): Draft {
  return {
    mode: (c?.execution_mode_default as ExecutionMode) || "suggestion",
    seuilSemi: c?.auto_min_confidence_default ?? "",
  };
}

function toPayload(d: Draft): ConfigUpdate {
  const p: ConfigUpdate = { execution_mode_default: d.mode };
  if (d.seuilSemi !== "") p.auto_min_confidence_default = Number(d.seuilSemi);
  return p;
}

/**
 * Le mode d'exécution par défaut — le seul réglage du produit qui, à lui seul, autorise le
 * moteur à ÉCRIRE dans GLPI pour toute entité sans mode explicite. Il est seul sur son écran
 * pour cette raison, et son enregistrement demande une confirmation nommant la conséquence.
 */
export function Modes() {
  const t = useT();
  const cfg = useConfigDraft(
    toDraft,
    toPayload,
    tr(
      "Mode par défaut enregistré. Il prend effet au prochain cycle de traitement.",
      "Default mode saved. It takes effect on the next processing cycle.",
    ),
  );
  const { draft, saved, patch } = cfg;

  const modeLabel = (m: ExecutionMode) =>
    m === "suggestion"
      ? t("Suggestion", "Suggestion")
      : m === "semi_auto"
        ? t("Semi-auto", "Semi-auto")
        : t("Full-auto", "Full-auto");

  // `domain/modes.resolve_action()` mute GLPI en semi_auto DÈS que la confiance dépasse le
  // seuil : le bandeau ne peut pas être réservé à full_auto (c'est ce que fait déjà Scope).
  const ecrit = draft.mode !== "suggestion";
  // Le franchissement qui ARME l'écriture : enregistré en suggestion, brouillon au-delà.
  const armeEcriture = saved.mode === "suggestion" && ecrit;

  // Seuil semi-auto sous le seuil de confiance = réglage sans effet : `engine.evaluate()`
  // a déjà renvoyé « à trier » avant que le mode ne soit consulté.
  //
  // La comparaison porte sur le seuil de confiance EN VIGUEUR (celui du serveur), pas sur un
  // brouillon : il se règle maintenant sur l'écran « Garde-fous », et l'avertissement doit
  // dire ce qui est vrai du moteur, pas ce qui serait vrai si un autre écran était enregistré.
  const seuilConfiance = cfg.config?.confidence_threshold ?? "";
  const conf = Number(seuilConfiance);
  const semi = Number(draft.seuilSemi);
  const seuilInutile =
    seuilConfiance !== "" &&
    draft.seuilSemi !== "" &&
    Number.isFinite(conf) &&
    Number.isFinite(semi) &&
    semi < conf;

  function confirmer(): boolean {
    if (!armeEcriture) return true;
    return window.confirm(
      t(
        `Passer le mode par défaut de « Suggestion » à « ${modeLabel(draft.mode)} » ?\n\nL'IA modifiera catégorie, priorité, assignation et répondra au demandeur, pour toute entité sans mode explicite.`,
        `Switch the default mode from “Suggestion” to “${modeLabel(draft.mode)}”?\n\nThe AI will modify category, priority, assignment and reply to the requester, for every entity without an explicit mode.`,
      ),
    );
  }

  return (
    <div className="space-y-6">
      <ErreurDeLecture error={cfg.error} />
      <Card>
        <PanelHead
          title={
            <HeadTitle icon={<ShieldHalf />}>
              {t("Mode d'exécution par défaut", "Default execution mode")}
            </HeadTitle>
          }
          subtitle={t(
            "S'applique aux entités sans mode explicite. Réglable par entité dans « Règles métier ».",
            "Applies to entities without an explicit mode. Tunable per entity in “Business rules”.",
          )}
          right={<Tag tone={MODE_TONE[draft.mode]}>{modeLabel(draft.mode)}</Tag>}
        />
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              htmlFor="cfg-mode-default"
              label={t("Mode par défaut", "Default mode")}
              hint={t(
                "suggestion : aucune écriture · semi/full-auto : applique la Décision et répond au demandeur.",
                "suggestion: no write · semi/full-auto: applies the Decision and replies to the requester.",
              )}
            >
              <Select
                id="cfg-mode-default"
                value={draft.mode}
                onChange={(e) => patch({ mode: e.target.value as ExecutionMode })}
              >
                <option value="suggestion">{t("Suggestion (sûr)", "Suggestion (safe)")}</option>
                <option value="semi_auto">
                  {t("Semi-auto (≥ seuil)", "Semi-auto (≥ threshold)")}
                </option>
                <option value="full_auto">Full-auto</option>
              </Select>
            </Field>
            <Field
              htmlFor="cfg-semi-threshold"
              label={t("Seuil du mode semi-auto (0 – 1)", "Semi-auto threshold (0 – 1)")}
              hint={t(
                "SECOND cran, appliqué après le seuil de confiance et uniquement en semi-auto : en dessous, la Décision n'est pas écrite dans GLPI, le ticket part « à trier » avec un Suivi privé « non tranché ». Repères : 0,5 permissif · 0,7 équilibré · 0,9 strict.",
                "A SECOND gate, applied after the confidence threshold and only in semi-auto: below it the Decision is not written to GLPI, the ticket goes “to triage” with a private “undecided” follow-up. Guides: 0.5 permissive · 0.7 balanced · 0.9 strict.",
              )}
            >
              <Input
                id="cfg-semi-threshold"
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={draft.seuilSemi}
                placeholder="0.9"
                onChange={(e) => patch({ seuilSemi: e.target.value })}
              />
            </Field>
          </div>
          {seuilInutile && (
            // `role="status"` : l'avertissement APPARAIT en reaction a une saisie. Sans lui,
            // un lecteur d'ecran ne dit rien. C'est la convention du depot (Dashboard, Scope,
            // Journal, Status l'appliquent) ; seuls les ecrans du moteur l'avaient perdue.
            <Banner kind="warning" role="status">
              {t(
                `Le seuil semi-auto (${draft.seuilSemi}) est inférieur au seuil de confiance en vigueur (${seuilConfiance}) : il n'a aucun effet, le seuil de confiance tranche avant lui.`,
                `The semi-auto threshold (${draft.seuilSemi}) is below the enforced confidence threshold (${seuilConfiance}): it has no effect, the confidence threshold already decides first.`,
              )}{" "}
              <Link
                className="underline underline-offset-2 hover:text-foreground"
                to="/engine/guardrails"
              >
                {t("Régler les garde-fous", "Adjust the guardrails")}
              </Link>
            </Banner>
          )}
          {ecrit && (
            // `role="alert"` : c'est le message le plus lourd du produit — il nomme le
            // passage en ECRITURE REELLE dans GLPI. Il apparaissait sans etre annonce.
            <Banner kind={draft.mode === "full_auto" ? "error" : "warning"} role="alert">
              {draft.mode === "full_auto"
                ? t(
                    "⚠ full_auto par défaut : toute entité sans mode explicite modifiera les tickets GLPI (catégorie, priorité, assignation) et répondra au demandeur, sans second seuil.",
                    "⚠ full_auto by default: any entity without an explicit mode will modify GLPI tickets (category, priority, assignment) and reply to the requester, with no second gate.",
                  )
                : t(
                    "⚠ semi_auto par défaut : toute entité sans mode explicite modifiera réellement les tickets GLPI (catégorie, priorité, assignation) et répondra au demandeur dès que la confiance dépasse le seuil semi-auto. Ce n'est PAS un mode d'observation.",
                    "⚠ semi_auto by default: any entity without an explicit mode will really modify GLPI tickets (category, priority, assignment) and reply to the requester as soon as confidence passes the semi-auto threshold. This is NOT an observation mode.",
                  )}
            </Banner>
          )}
        </CardContent>
      </Card>

      <SaveBar
        dirty={cfg.dirty}
        saving={cfg.saving}
        peutEnregistrer={cfg.config !== null}
        onSave={() => cfg.save(confirmer)}
        alerte={
          armeEcriture
            ? t(
                "Modifications non enregistrées — dont le passage en écriture réelle dans GLPI.",
                "Unsaved changes — including switching to real writes in GLPI.",
              )
            : undefined
        }
      />
    </div>
  );
}
