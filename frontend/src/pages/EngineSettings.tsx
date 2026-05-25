import { useCallback, useState } from "react";
import { Banner, PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";

export function EngineSettings() {
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const [threshold, setThreshold] = useState<string>("");
  const [cap, setCap] = useState<string>("");
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const c = cfg.data;

  async function save() {
    setMsg(null);
    try {
      await Api.updateConfig({
        ...(threshold !== "" ? { confidence_threshold: Number(threshold) } : {}),
        ...(cap !== "" ? { cost_cap_eur_per_day: Number(cap) } : {}),
      });
      setThreshold("");
      setCap("");
      cfg.reload();
      setMsg({ kind: "success", text: "Réglages du moteur enregistrés." });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: `Erreur : ${(e as Error).message}` });
    }
  }

  return (
    <>
      <PageHeader
        title="Moteur à garde-fous"
        description="Seuil de confiance (FR-8) et plafond de coût quotidien (FR-10)."
      />
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          <Field
            label="Seuil de confiance (0 – 1)"
            hint={`Actuel : ${c?.confidence_threshold ?? "—"}. Sous ce seuil → « à trier ». Valeur à calibrer.`}
          >
            <Input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={threshold}
              placeholder={c?.confidence_threshold ?? "0.7"}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </Field>
          <Field label="Cost cap (€/jour)" hint={`Actuel : ${c?.cost_cap_eur_per_day ?? "—"} €.`}>
            <Input
              type="number"
              step="0.5"
              min="0"
              value={cap}
              placeholder={c?.cost_cap_eur_per_day ?? "5"}
              onChange={(e) => setCap(e.target.value)}
            />
          </Field>
          <div>
            <Button onClick={save}>Enregistrer</Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
