import { useCallback, useState } from "react";
import { Banner, PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate } from "@/lib/api";

export function GlpiConnection() {
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const c = cfg.data;
  function set<K extends keyof ConfigUpdate>(k: K, v: ConfigUpdate[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    setMsg(null);
    try {
      await Api.updateConfig(form);
      setForm({});
      cfg.reload();
      health.reload();
      setMsg({ kind: "success", text: "Connexion GLPI enregistrée." });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: `Erreur : ${(e as Error).message}` });
    }
  }

  return (
    <>
      <PageHeader
        title="Connexion GLPI"
        description="API legacy apirest.php. Les tokens sont chiffrés au repos et jamais réaffichés."
        actions={
          health.data?.glpi.configured ? (
            health.data.glpi.reachable ? (
              <Badge variant="success">joignable</Badge>
            ) : (
              <Badge variant="destructive">injoignable</Badge>
            )
          ) : (
            <Badge variant="warn">non configurée</Badge>
          )
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          <Field label="URL de base (apirest.php)">
            <Input
              defaultValue={c?.glpi_base_url ?? ""}
              placeholder="https://glpi.exemple.local/apirest.php"
              onChange={(e) => set("glpi_base_url", e.target.value)}
            />
          </Field>
          <Field
            label="User token"
            hint={c?.glpi_user_token_set ? "Déjà configuré — laisser vide pour conserver." : undefined}
          >
            <Input type="password" placeholder="(inchangé)" onChange={(e) => set("glpi_user_token", e.target.value)} />
          </Field>
          <Field
            label="App token (optionnel)"
            hint={c?.glpi_app_token_set ? "Déjà configuré — laisser vide pour conserver." : undefined}
          >
            <Input type="password" placeholder="(inchangé)" onChange={(e) => set("glpi_app_token", e.target.value)} />
          </Field>
          <div>
            <Button onClick={save}>Enregistrer</Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
