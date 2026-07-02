import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dot } from "@/components/ui/dot";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate, type LlmProvider, PROVIDER_LABELS } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const PROVIDERS: LlmProvider[] = ["mistral", "openai", "ollama", "anthropic"];
const NON_SOVEREIGN: LlmProvider[] = ["openai", "anthropic"];
// Champs de `form` propres à chaque fournisseur — sert à purger au changement de
// sélection ce qui n'est plus affiché (jamais envoyer une clé/URL abandonnée).
const PROVIDER_KEYS: Record<LlmProvider, (keyof ConfigUpdate)[]> = {
  mistral: ["llm_base_url", "llm_model", "llm_api_key"],
  openai: ["openai_base_url", "openai_model", "openai_api_key"],
  ollama: ["ollama_base_url", "ollama_model"],
  anthropic: ["anthropic_base_url", "anthropic_model", "anthropic_api_key"],
};
const PROVIDER_DESC: Record<LlmProvider, { fr: string; en: string }> = {
  mistral: { fr: "souverain · UE", en: "sovereign · EU" },
  openai: { fr: "cloud · hors UE", en: "cloud · non-EU" },
  ollama: { fr: "local · aucune clé", en: "local · no key" },
  anthropic: { fr: "cloud · hors UE", en: "cloud · non-EU" },
};

export function AiProvider() {
  const t = useT();
  const toast = useToast();
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [provider, setProvider] = useState<LlmProvider>("mistral");
  const [saving, setSaving] = useState(false);

  const c = cfg.data;
  useEffect(() => {
    if (c?.llm_provider) setProvider(c.llm_provider);
  }, [c?.llm_provider]);

  function set<K extends keyof ConfigUpdate>(k: K, v: ConfigUpdate[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Changement de fournisseur : purge de `form` les champs des AUTRES fournisseurs,
  // pour ne jamais envoyer une clé/URL saisie pour un fournisseur puis abandonné.
  function selectProvider(next: LlmProvider) {
    if (next === provider) return;
    setProvider(next);
    setForm((f) => {
      const copy = { ...f };
      for (const p of PROVIDERS) {
        if (p === next) continue;
        for (const k of PROVIDER_KEYS[p]) delete copy[k];
      }
      return copy;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await Api.updateConfig({ ...form, llm_provider: provider });
      setForm({});
      cfg.reload();
      toast.success(t("Fournisseur IA enregistré.", "AI provider saved."));
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    } finally {
      setSaving(false);
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

  // Fournisseur réellement opérationnel = sa clé est configurée (ollama : local, pas de clé).
  const isOperational = (p: LlmProvider) => (p === "ollama" ? true : fields[p].keySet);
  // Fournisseur « live » = celui ENREGISTRÉ côté moteur (c.llm_provider), pas l'état du sélecteur.
  const savedProvider = c?.llm_provider;

  return (
    <div className="space-y-4">
      {/* GET config en échec : on prévient plutôt que d'afficher un formulaire muet
          dont l'enregistrement écraserait la config réelle par les défauts locaux. */}
      {cfg.error && (
        <Banner kind="error">
          {t("Impossible de charger la configuration :", "Could not load the configuration:")}{" "}
          {cfg.error}
        </Banner>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {PROVIDERS.map((p) => {
          const on = provider === p;
          // Le moteur tourne sur ce fournisseur ET sa clé est en place → live.
          const live = p === savedProvider && isOperational(p);
          // Enregistré mais clé manquante → actif mais non-opérationnel (amber, discret).
          const degraded = p === savedProvider && !isOperational(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => selectProvider(p)}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                on
                  ? "border-primary/50 bg-primary/10"
                  : "border-border bg-transparent hover:border-primary/30",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                  {live && (
                    <span title={t("En service", "In service")} className="flex items-center">
                      <Dot tone="green" pulse />
                    </span>
                  )}
                  {degraded && (
                    <span
                      title={t("Actif — clé manquante", "Active — key missing")}
                      className="flex items-center"
                    >
                      <Dot tone="amber" />
                    </span>
                  )}
                  <span className="truncate">{PROVIDER_LABELS[p]}</span>
                </span>
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
          <Field label={t("URL de base", "Base URL")}>
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
            <Button onClick={save} disabled={!cfg.data || saving}>
              {saving ? t("Enregistrement…", "Saving…") : t("Enregistrer", "Save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
