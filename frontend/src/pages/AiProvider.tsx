import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Banner, PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate, type LlmProvider } from "@/lib/api";

export function AiProvider() {
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [provider, setProvider] = useState<LlmProvider>("openai_compatible");
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

  return (
    <>
      <PageHeader
        title="Fournisseur IA"
        description="Mistral EU (souverain, défaut) ou Anthropic Claude. Clé chiffrée au repos, jamais réaffichée."
      />
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

          <Field label="Fournisseur">
            <div className="flex gap-2">
              {(["openai_compatible", "anthropic"] as LlmProvider[]).map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={provider === p ? "default" : "outline"}
                  onClick={() => setProvider(p)}
                >
                  {p === "openai_compatible" ? "Mistral EU / OpenAI-compatible" : "Anthropic (Claude)"}
                </Button>
              ))}
            </div>
          </Field>

          {provider === "openai_compatible" ? (
            <>
              <Field label="Base URL">
                <Input
                  defaultValue={c?.llm_base_url ?? ""}
                  placeholder="https://api.mistral.ai/v1"
                  onChange={(e) => set("llm_base_url", e.target.value)}
                />
              </Field>
              <Field label="Modèle">
                <Input
                  defaultValue={c?.llm_model ?? ""}
                  placeholder="mistral-large-latest"
                  onChange={(e) => set("llm_model", e.target.value)}
                />
              </Field>
              <Field
                label="Clé API"
                hint={c?.llm_api_key_set ? "Déjà configurée — laisser vide pour conserver." : undefined}
              >
                <Input type="password" placeholder="(inchangée)" onChange={(e) => set("llm_api_key", e.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Anthropic est hors UE (non-souverain) — à valider avec la DPO avant activation.
              </div>
              <Field label="Base URL Anthropic">
                <Input
                  defaultValue={c?.anthropic_base_url ?? ""}
                  placeholder="https://api.anthropic.com"
                  onChange={(e) => set("anthropic_base_url", e.target.value)}
                />
              </Field>
              <Field label="Modèle Anthropic">
                <Input
                  defaultValue={c?.anthropic_model ?? ""}
                  placeholder="claude-sonnet-4-6"
                  onChange={(e) => set("anthropic_model", e.target.value)}
                />
              </Field>
              <Field
                label="Clé API Anthropic"
                hint={
                  c?.anthropic_api_key_set ? (
                    <Badge variant="success">configurée</Badge>
                  ) : undefined
                }
              >
                <Input
                  type="password"
                  placeholder="(inchangée)"
                  onChange={(e) => set("anthropic_api_key", e.target.value)}
                />
              </Field>
            </>
          )}

          <div>
            <Button onClick={save}>Enregistrer</Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
