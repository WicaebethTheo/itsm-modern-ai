import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate, asBool } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";

const SYS_MAX = 8000;

export function EngineSettings() {
  const t = useT();
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [pollingOn, setPollingOn] = useState(true);
  const [sysPrompt, setSysPrompt] = useState("");
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const c = cfg.data;

  useEffect(() => {
    if (c) {
      setPollingOn(asBool(c.polling_enabled));
      setSysPrompt(c.system_prompt ?? "");
    }
  }, [c]);

  function set<K extends keyof ConfigUpdate>(k: K, v: ConfigUpdate[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }
  const num = (v: string) => (v === "" ? undefined : Number(v));

  async function save() {
    setMsg(null);
    try {
      await Api.updateConfig({ ...form, polling_enabled: pollingOn, system_prompt: sysPrompt });
      setForm({});
      cfg.reload();
      setMsg({ kind: "success", text: t("Réglages enregistrés.", "Settings saved.") });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: `${t("Erreur", "Error")} : ${(e as Error).message}` });
    }
  }

  return (
    <div className="space-y-4">
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

      {/* Garde-fous */}
      <Card>
        <PanelHead title={t("Garde-fous", "Guardrails")} />
        <CardContent className="flex flex-col gap-4 p-5">
          <Field
            label={t("Seuil de confiance (0 – 1)", "Confidence threshold (0 – 1)")}
            hint={t(
              `Actuel : ${c?.confidence_threshold ?? "—"}. Sous ce seuil → « à trier ».`,
              `Current: ${c?.confidence_threshold ?? "—"}. Below it → “to triage”.`,
            )}
          >
            <Input
              type="number"
              step="0.05"
              min="0"
              max="1"
              placeholder={c?.confidence_threshold ?? "0.7"}
              onChange={(e) => set("confidence_threshold", num(e.target.value))}
            />
          </Field>
          <Field
            label={t("Plafond de coût (€/jour)", "Cost ceiling (€/day)")}
            hint={t(
              `Actuel : ${c?.cost_cap_eur_per_day ?? "—"} €. 0 = pas de plafond.`,
              `Current: ${c?.cost_cap_eur_per_day ?? "—"} €. 0 = no ceiling.`,
            )}
          >
            <Input
              type="number"
              step="0.5"
              min="0"
              placeholder={c?.cost_cap_eur_per_day ?? "5"}
              onChange={(e) => set("cost_cap_eur_per_day", num(e.target.value))}
            />
          </Field>
          <Field
            label={t("Tentatives LLM (retries)", "LLM retries")}
            hint={t(`Actuel : ${c?.llm_retries ?? "—"}.`, `Current: ${c?.llm_retries ?? "—"}.`)}
          >
            <Input
              type="number"
              min="0"
              max="5"
              placeholder={c?.llm_retries ?? "1"}
              onChange={(e) => set("llm_retries", num(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Qualité de la suggestion */}
      <Card>
        <PanelHead
          title={t("Qualité de la suggestion", "Suggestion quality")}
          subtitle={t(
            "Impacte le brouillon de réponse proposé (mode suggestion)",
            "Affects the proposed draft reply (suggestion mode)",
          )}
        />
        <CardContent className="flex flex-col gap-4 p-5">
          <Field label={t("Ton de la réponse", "Reply tone")}>
            <Input
              defaultValue={c?.response_tone ?? ""}
              placeholder={t(
                "professionnel, courtois et concis",
                "professional, courteous and concise",
              )}
              onChange={(e) => set("response_tone", e.target.value)}
            />
          </Field>
          <Field
            label={t(
              "Nom de l'assistant (signature, optionnel)",
              "Assistant name (signature, optional)",
            )}
          >
            <Input
              defaultValue={c?.assistant_name ?? ""}
              placeholder={t("Support IT", "IT Support")}
              onChange={(e) => set("assistant_name", e.target.value)}
            />
          </Field>
          <Field
            label={t(
              "Consignes de routage (langage naturel, optionnel)",
              "Routing guidance (natural language, optional)",
            )}
          >
            <Textarea
              defaultValue={c?.routing_rules ?? ""}
              placeholder={t(
                "Ex. : les tickets mentionnant la paie vont à l'équipe RH ; les incidents sécurité sont prioritaires…",
                "E.g.: tickets mentioning payroll go to HR; security incidents are priority…",
              )}
              onChange={(e) => set("routing_rules", e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Polling */}
      <Card>
        <PanelHead title={t("Polling", "Polling")} />
        <CardContent className="flex flex-col gap-4 p-5">
          <Toggle
            checked={pollingOn}
            onChange={setPollingOn}
            label={t("Polling activé", "Polling enabled")}
            description={t(
              "Le moteur traite les nouveaux tickets en continu.",
              "The engine processes new tickets continuously.",
            )}
          />
          <Field
            label={t("Intervalle de polling (secondes)", "Polling interval (seconds)")}
            hint={t(
              `Actuel : ${c?.polling_interval_seconds ?? "—"} s. Appliqué immédiatement.`,
              `Current: ${c?.polling_interval_seconds ?? "—"} s. Applied immediately.`,
            )}
          >
            <Input
              type="number"
              min="10"
              placeholder={c?.polling_interval_seconds ?? "60"}
              onChange={(e) => set("polling_interval_seconds", num(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Dashboard inversé */}
      <Card>
        <PanelHead title={t("Dashboard inversé", "Inverted dashboard")} />
        <CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <Field
            label={t("Fenêtre (jours)", "Window (days)")}
            hint={t(
              `Actuel : ${c?.dashboard_window_days ?? "—"} j.`,
              `Current: ${c?.dashboard_window_days ?? "—"} d.`,
            )}
          >
            <Input
              type="number"
              min="1"
              max="365"
              placeholder={c?.dashboard_window_days ?? "7"}
              onChange={(e) => set("dashboard_window_days", num(e.target.value))}
            />
          </Field>
          <Field
            label={t(
              "Anomalie : âge max d'un ticket « New » (h)",
              "Anomaly: max age of a “New” ticket (h)",
            )}
            hint={t(
              `Actuel : ${c?.anomaly_new_age_hours ?? "—"} h.`,
              `Current: ${c?.anomaly_new_age_hours ?? "—"} h.`,
            )}
          >
            <Input
              type="number"
              min="1"
              max="720"
              placeholder={c?.anomaly_new_age_hours ?? "24"}
              onChange={(e) => set("anomaly_new_age_hours", num(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Prompt système */}
      <Card>
        <PanelHead title={t("Prompt système (avancé)", "System prompt (advanced)")} />
        <CardContent className="flex flex-col gap-3 p-5">
          <p className="text-[12.5px] text-muted-foreground">
            {t(
              "Surcharge les instructions données au LLM. Vide = prompt par défaut. Le code valide toujours la Décision (whitelist, seuil) — modifier le prompt n'enlève aucun garde-fou.",
              "Overrides the LLM instructions. Empty = built-in default. The code always validates the Decision (whitelist, threshold) — editing the prompt removes no guardrail.",
            )}
          </p>
          <Textarea
            className="min-h-48 font-mono text-xs"
            value={sysPrompt}
            maxLength={SYS_MAX}
            placeholder={c?.system_prompt_default ?? t("Prompt par défaut…", "Default prompt…")}
            onChange={(e) => setSysPrompt(e.target.value)}
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {sysPrompt.length} / {SYS_MAX} {t("caractères", "characters")}
              {sysPrompt.trim() === "" ? t(" — (défaut utilisé)", " — (default used)") : ""}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSysPrompt("")}>
              {t("Réinitialiser au défaut", "Reset to default")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Button onClick={save}>{t("Enregistrer", "Save")}</Button>
    </div>
  );
}
