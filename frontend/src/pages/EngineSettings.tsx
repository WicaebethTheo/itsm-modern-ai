import { Banner, PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate, asBool } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";

export function EngineSettings() {
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [pollingOn, setPollingOn] = useState(true);
  const [sysPrompt, setSysPrompt] = useState("");
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const c = cfg.data;
  const SYS_MAX = 8000;

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
      setMsg({ kind: "success", text: "Réglages enregistrés." });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: `Erreur : ${(e as Error).message}` });
    }
  }

  return (
    <>
      <PageHeader
        title="Moteur & réglages"
        description="Garde-fous, qualité de la suggestion, polling et dashboard."
      />
      {msg && (
        <div className="mb-4">
          <Banner kind={msg.kind}>{msg.text}</Banner>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Garde-fous</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field
              label="Seuil de confiance (0 – 1)"
              hint={`Actuel : ${c?.confidence_threshold ?? "—"}. Sous ce seuil → « à trier ».`}
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
              label="Cost cap (€/jour)"
              hint={`Actuel : ${c?.cost_cap_eur_per_day ?? "—"} €. 0 = pas de plafond.`}
            >
              <Input
                type="number"
                step="0.5"
                min="0"
                placeholder={c?.cost_cap_eur_per_day ?? "5"}
                onChange={(e) => set("cost_cap_eur_per_day", num(e.target.value))}
              />
            </Field>
            <Field label="Tentatives LLM (retries)" hint={`Actuel : ${c?.llm_retries ?? "—"}.`}>
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

        <Card>
          <CardHeader>
            <CardTitle>Qualité de la suggestion</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Impacte le brouillon de réponse proposé au demandeur (utile côté utilisateur final).
            </p>
            <Field label="Ton de la réponse">
              <Input
                defaultValue={c?.response_tone ?? ""}
                placeholder="professionnel, courtois et concis"
                onChange={(e) => set("response_tone", e.target.value)}
              />
            </Field>
            <Field label="Nom de l'assistant (signature, optionnel)">
              <Input
                defaultValue={c?.assistant_name ?? ""}
                placeholder="Support IT"
                onChange={(e) => set("assistant_name", e.target.value)}
              />
            </Field>
            <Field label="Consignes de routage (langage naturel, optionnel)">
              <Textarea
                defaultValue={c?.routing_rules ?? ""}
                placeholder="Ex. : les tickets mentionnant la paie vont à l'équipe RH ; les incidents sécurité sont prioritaires…"
                onChange={(e) => set("routing_rules", e.target.value)}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Polling</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={pollingOn}
                onChange={(e) => setPollingOn(e.target.checked)}
              />
              Polling activé (le moteur traite les nouveaux tickets)
            </label>
            <Field
              label="Intervalle de polling (secondes)"
              hint={`Actuel : ${c?.polling_interval_seconds ?? "—"} s. Appliqué immédiatement.`}
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

        <Card>
          <CardHeader>
            <CardTitle>Dashboard inversé</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Fenêtre (jours)" hint={`Actuel : ${c?.dashboard_window_days ?? "—"} j.`}>
              <Input
                type="number"
                min="1"
                max="365"
                placeholder={c?.dashboard_window_days ?? "7"}
                onChange={(e) => set("dashboard_window_days", num(e.target.value))}
              />
            </Field>
            <Field
              label="Anomalie : âge max d'un ticket « New » (heures)"
              hint={`Actuel : ${c?.anomaly_new_age_hours ?? "—"} h.`}
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

        <Card>
          <CardHeader>
            <CardTitle>Prompt système (avancé)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Surcharge les instructions données au LLM. Laisser vide = prompt par défaut intégré.
              Le code valide toujours la Décision (whitelist, seuil) — modifier le prompt n'enlève
              aucun garde-fou.
            </p>
            <Textarea
              className="min-h-48 font-mono text-xs"
              value={sysPrompt}
              maxLength={SYS_MAX}
              placeholder={c?.system_prompt_default ?? "Prompt par défaut…"}
              onChange={(e) => setSysPrompt(e.target.value)}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {sysPrompt.length} / {SYS_MAX} caractères
                {sysPrompt.trim() === "" ? " — (défaut utilisé)" : ""}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSysPrompt("")}>
                Réinitialiser au défaut
              </Button>
            </div>
          </CardContent>
        </Card>

        <div>
          <Button onClick={save}>Enregistrer</Button>
        </div>
      </div>
    </>
  );
}
