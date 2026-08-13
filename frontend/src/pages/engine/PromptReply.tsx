import { MessageSquareText, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Textarea } from "@/components/ui/textarea";
import { useConfigDraft } from "@/hooks/useConfigDraft";
import type { ConfigUpdate, ConfigView } from "@/lib/api";
import { tr, useT } from "@/lib/i18n";
import { ErreurDeLecture, HeadTitle, SaveBar } from "./shared";

const SYS_MAX = 8000;

interface Draft {
  ton: string;
  assistant: string;
  routage: string;
  prompt: string;
}

function toDraft(c: ConfigView | null): Draft {
  return {
    ton: c?.response_tone ?? "",
    assistant: c?.assistant_name ?? "",
    routage: c?.routing_rules ?? "",
    prompt: c?.system_prompt ?? "",
  };
}

// Ces quatre champs sont du TEXTE : une chaîne vide y est une valeur (« pas de signature »,
// « prompt par défaut »), pas une absence de saisie. On les envoie donc toujours.
function toPayload(d: Draft): ConfigUpdate {
  return {
    response_tone: d.ton,
    assistant_name: d.assistant,
    routing_rules: d.routage,
    system_prompt: d.prompt,
  };
}

/**
 * Ce qu'on DIT au modèle, et ce qu'il rend au demandeur.
 *
 * Le prompt système était rangé sous « Avancé » à l'autre bout de la page, à trois écrans de
 * défilement du ton et des consignes de routage — alors que les quatre réglages composent une
 * seule et même instruction envoyée au LLM. Ils tiennent maintenant sur un écran.
 */
export function PromptReply() {
  const t = useT();
  const cfg = useConfigDraft(
    toDraft,
    toPayload,
    tr(
      "Instructions enregistrées. Elles prennent effet au prochain cycle de traitement.",
      "Instructions saved. They take effect on the next processing cycle.",
    ),
  );
  const { draft, patch } = cfg;

  return (
    <div className="space-y-6">
      <ErreurDeLecture error={cfg.error} />

      <Card>
        <PanelHead
          title={
            <HeadTitle icon={<MessageSquareText />}>
              {t("Réponse au demandeur", "Reply to the requester")}
            </HeadTitle>
          }
          subtitle={t(
            "Impacte le brouillon de réponse proposé (mode suggestion)",
            "Affects the proposed draft reply (suggestion mode)",
          )}
        />
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field htmlFor="cfg-tone" label={t("Ton de la réponse", "Reply tone")}>
              <Input
                id="cfg-tone"
                value={draft.ton}
                placeholder={t(
                  "professionnel, courtois et concis",
                  "professional, courteous and concise",
                )}
                onChange={(e) => patch({ ton: e.target.value })}
              />
            </Field>
            <Field
              htmlFor="cfg-assistant"
              label={t(
                "Nom de l'assistant (signature, optionnel)",
                "Assistant name (signature, optional)",
              )}
            >
              <Input
                id="cfg-assistant"
                value={draft.assistant}
                placeholder={t("Support IT", "IT Support")}
                onChange={(e) => patch({ assistant: e.target.value })}
              />
            </Field>
          </div>
          <Field
            htmlFor="cfg-routing"
            label={t(
              "Consignes de routage (langage naturel, optionnel)",
              "Routing guidance (natural language, optional)",
            )}
          >
            <Textarea
              id="cfg-routing"
              value={draft.routage}
              placeholder={t(
                "Ex. : les tickets mentionnant la paie vont à l'équipe RH ; les incidents sécurité sont prioritaires…",
                "E.g.: tickets mentioning payroll go to HR; security incidents are priority…",
              )}
              onChange={(e) => patch({ routage: e.target.value })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <PanelHead
          title={
            <HeadTitle icon={<Terminal />}>
              {t("Prompt système (avancé)", "System prompt (advanced)")}
            </HeadTitle>
          }
          subtitle={t(
            "Surcharge des instructions données au LLM",
            "Overrides the LLM instructions",
          )}
        />
        <CardContent className="flex flex-col gap-3">
          <p className="text-body text-muted-foreground">
            {t(
              "Surcharge les instructions données au LLM. Vide = prompt par défaut. Le code valide toujours la Décision (whitelist, seuil) — modifier le prompt n'enlève aucun garde-fou.",
              "Overrides the LLM instructions. Empty = built-in default. The code always validates the Decision (whitelist, threshold) — editing the prompt removes no guardrail.",
            )}
          </p>
          <Textarea
            id="cfg-system-prompt"
            aria-label={t("Prompt système", "System prompt")}
            className="min-h-48 font-mono text-body"
            value={draft.prompt}
            maxLength={SYS_MAX}
            placeholder={
              cfg.config?.system_prompt_default ?? t("Prompt par défaut…", "Default prompt…")
            }
            onChange={(e) => patch({ prompt: e.target.value })}
          />
          <div className="flex items-center justify-between text-caption text-muted-foreground">
            <span>
              {draft.prompt.length} / {SYS_MAX} {t("caractères", "characters")}
              {draft.prompt.trim() === "" ? t(" — (défaut utilisé)", " — (default used)") : ""}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => patch({ prompt: "" })}>
              {t("Réinitialiser au défaut", "Reset to default")}
            </Button>
          </div>
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
