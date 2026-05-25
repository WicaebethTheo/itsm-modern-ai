import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Banner, PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Api, type ConfigUpdate, type LlmProvider, PROVIDER_LABELS } from "@/lib/api";
import { useResource } from "@/hooks/useResource";

const PROVIDERS: LlmProvider[] = ["mistral", "openai", "ollama", "anthropic"];
const NON_SOVEREIGN: LlmProvider[] = ["openai", "anthropic"];

export function AiProvider() {
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
      setMsg({ kind: "success", text: "Fournisseur IA enregistré." });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: `Erreur : ${(e as Error).message}` });
    }
  }

  // Champs par fournisseur : [base_url key, model key, secret key | null, défauts]
  const fields: Record<
    LlmProvider,
    { baseKey: keyof ConfigUpdate; modelKey: keyof ConfigUpdate; secretKey: keyof ConfigUpdate | null; keySet: boolean; basePh: string; modelPh: string }
  > = {
    mistral: { baseKey: "llm_base_url", modelKey: "llm_model", secretKey: "llm_api_key", keySet: !!c?.llm_api_key_set, basePh: "https://api.mistral.ai/v1", modelPh: "mistral-large-latest" },
    openai: { baseKey: "openai_base_url", modelKey: "openai_model", secretKey: "openai_api_key", keySet: !!c?.openai_api_key_set, basePh: "https://api.openai.com/v1", modelPh: "gpt-4o-mini" },
    ollama: { baseKey: "ollama_base_url", modelKey: "ollama_model", secretKey: null, keySet: false, basePh: "http://localhost:11434/v1", modelPh: "llama3.1" },
    anthropic: { baseKey: "anthropic_base_url", modelKey: "anthropic_model", secretKey: "anthropic_api_key", keySet: !!c?.anthropic_api_key_set, basePh: "https://api.anthropic.com", modelPh: "claude-sonnet-4-6" },
  };
  const f = fields[provider];
  const currentBase = (c?.[f.baseKey as keyof typeof c] as string) ?? "";
  const currentModel = (c?.[f.modelKey as keyof typeof c] as string) ?? "";

  return (
    <>
      <PageHeader
        title="Fournisseur IA"
        description="Choisissez le moteur de langage. Mistral EU est souverain ; Ollama est 100% local."
      />
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

          <Field label="Fournisseur">
            <div className="flex flex-wrap gap-2">
              {PROVIDERS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={provider === p ? "default" : "outline"}
                  onClick={() => setProvider(p)}
                >
                  {PROVIDER_LABELS[p]}
                </Button>
              ))}
            </div>
          </Field>

          {NON_SOVEREIGN.includes(provider) && (
            <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {PROVIDER_LABELS[provider]} est hors UE (non-souverain) — à valider avec la DPO.
            </div>
          )}
          {provider === "ollama" && (
            <p className="text-sm text-muted-foreground">
              Modèle local : aucune donnée ne sort de votre infrastructure, aucune clé requise.
            </p>
          )}

          <Field label="Base URL">
            <Input
              key={`${provider}-base`}
              defaultValue={currentBase}
              placeholder={f.basePh}
              onChange={(e) => set(f.baseKey, e.target.value)}
            />
          </Field>
          <Field label="Modèle">
            <Input
              key={`${provider}-model`}
              defaultValue={currentModel}
              placeholder={f.modelPh}
              onChange={(e) => set(f.modelKey, e.target.value)}
            />
          </Field>
          {f.secretKey && (
            <Field
              label="Clé API"
              hint={f.keySet ? <Badge variant="success">configurée</Badge> : "Non configurée"}
            >
              <Input
                key={`${provider}-key`}
                type="password"
                placeholder="(inchangée)"
                onChange={(e) => set(f.secretKey as keyof ConfigUpdate, e.target.value)}
              />
            </Field>
          )}

          <div>
            <Button onClick={save}>Enregistrer</Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
