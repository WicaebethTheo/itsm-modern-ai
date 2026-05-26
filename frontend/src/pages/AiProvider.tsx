import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate, type LlmProvider, PROVIDER_LABELS } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const PROVIDERS: LlmProvider[] = ["mistral", "openai", "ollama", "anthropic"];
const NON_SOVEREIGN: LlmProvider[] = ["openai", "anthropic"];
const PROVIDER_DESC: Record<LlmProvider, { fr: string; en: string }> = {
  mistral: { fr: "souverain · UE", en: "sovereign · EU" },
  openai: { fr: "cloud · hors UE", en: "cloud · non-EU" },
  ollama: { fr: "local · aucune clé", en: "local · no key" },
  anthropic: { fr: "cloud · hors UE", en: "cloud · non-EU" },
};

export function AiProvider() {
  const t = useT();
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [provider, setProvider] = useState<LlmProvider>("mistral");
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const c = cfg.data;
  useEffect(() => {
    if (c?.llm_provider) setProvider(c.llm_provider);
  }, [c?.llm_provider]);

  function set<K extends keyof ConfigUpdate>(k: K, v: ConfigUpdate[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    setMsg(null);
    try {
      await Api.updateConfig({ ...form, llm_provider: provider });
      setForm({});
      cfg.reload();
      setMsg({ kind: "success", text: t("Fournisseur IA enregistré.", "AI provider saved.") });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: `${t("Erreur", "Error")} : ${(e as Error).message}` });
    }
  }

  const fields: Record<
    LlmProvider,
    {
      baseKey: keyof ConfigUpdate;
      modelKey: keyof ConfigUpdate;
      secretKey: keyof ConfigUpdate | null;
      keySet: boolean;
      basePh: string;
      modelPh: string;
    }
  > = {
    mistral: {
      baseKey: "llm_base_url",
      modelKey: "llm_model",
      secretKey: "llm_api_key",
      keySet: !!c?.llm_api_key_set,
      basePh: "https://api.mistral.ai/v1",
      modelPh: "mistral-large-latest",
    },
    openai: {
      baseKey: "openai_base_url",
      modelKey: "openai_model",
      secretKey: "openai_api_key",
      keySet: !!c?.openai_api_key_set,
      basePh: "https://api.openai.com/v1",
      modelPh: "gpt-4o-mini",
    },
    ollama: {
      baseKey: "ollama_base_url",
      modelKey: "ollama_model",
      secretKey: null,
      keySet: false,
      basePh: "http://localhost:11434/v1",
      modelPh: "llama3.1",
    },
    anthropic: {
      baseKey: "anthropic_base_url",
      modelKey: "anthropic_model",
      secretKey: "anthropic_api_key",
      keySet: !!c?.anthropic_api_key_set,
      basePh: "https://api.anthropic.com",
      modelPh: "claude-sonnet-4-6",
    },
  };
  const f = fields[provider];
  const currentBase = (c?.[f.baseKey as keyof typeof c] as string) ?? "";
  const currentModel = (c?.[f.modelKey as keyof typeof c] as string) ?? "";

  return (
    <div className="space-y-4">
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {PROVIDERS.map((p) => {
          const on = provider === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => setProvider(p)}
              className="rounded-lg border p-4 text-left transition-colors"
              style={{
                borderColor: on ? "rgba(99,102,241,0.5)" : "hsl(var(--border))",
                background: on ? "rgba(99,102,241,0.08)" : "transparent",
              }}
            >
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium">{PROVIDER_LABELS[p]}</span>
                {on && <Tag tone="indigo">{t("Actif", "Active")}</Tag>}
              </div>
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                {t(PROVIDER_DESC[p].fr, PROVIDER_DESC[p].en)}
              </div>
            </button>
          );
        })}
      </div>

      {NON_SOVEREIGN.includes(provider) && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t(
            `${PROVIDER_LABELS[provider]} est hors UE (non-souverain) — à valider avec la DPO.`,
            `${PROVIDER_LABELS[provider]} is outside the EU (non-sovereign) — to validate with the DPO.`,
          )}
        </div>
      )}
      {provider === "ollama" && (
        <p className="text-[12.5px] text-muted-foreground">
          {t(
            "Modèle local : aucune donnée ne sort de votre infrastructure, aucune clé requise.",
            "Local model: no data leaves your infrastructure, no key required.",
          )}
        </p>
      )}

      <Card className="max-w-md">
        <PanelHead
          title={t("Configuration", "Configuration")}
          subtitle={PROVIDER_LABELS[provider]}
        />
        <CardContent className="flex flex-col gap-4 p-5">
          <Field label="Base URL">
            <Input
              key={`${provider}-base`}
              defaultValue={currentBase}
              placeholder={f.basePh}
              onChange={(e) => set(f.baseKey, e.target.value)}
            />
          </Field>
          <Field label={t("Modèle", "Model")}>
            <Input
              key={`${provider}-model`}
              defaultValue={currentModel}
              placeholder={f.modelPh}
              onChange={(e) => set(f.modelKey, e.target.value)}
            />
          </Field>
          {f.secretKey && (
            <Field
              label={t("Clé API", "API key")}
              hint={
                f.keySet ? (
                  <Tag tone="green">{t("configurée", "configured")}</Tag>
                ) : (
                  t("Non configurée", "Not configured")
                )
              }
            >
              <Input
                key={`${provider}-key`}
                type="password"
                placeholder={t("(inchangée)", "(unchanged)")}
                onChange={(e) => set(f.secretKey as keyof ConfigUpdate, e.target.value)}
              />
            </Field>
          )}
          <div>
            <Button onClick={save}>{t("Enregistrer", "Save")}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
