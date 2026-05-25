import { Banner, PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate, asBool } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";

export function GlpiConnection() {
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [verifyTls, setVerifyTls] = useState(true);
  const [legacy9x, setLegacy9x] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const c = cfg.data;
  useEffect(() => {
    if (c) {
      setVerifyTls(asBool(c.glpi_verify_tls));
      setLegacy9x(asBool(c.glpi_followup_legacy_9x));
    }
  }, [c]);

  function set<K extends keyof ConfigUpdate>(k: K, v: ConfigUpdate[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    setMsg(null);
    try {
      await Api.updateConfig({
        ...form,
        glpi_verify_tls: verifyTls,
        glpi_followup_legacy_9x: legacy9x,
      });
      setForm({});
      cfg.reload();
      health.reload();
      setMsg({ kind: "success", text: "Connexion GLPI enregistrée." });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: `Erreur : ${(e as Error).message}` });
    }
  }

  async function testConnection() {
    setTesting(true);
    setMsg(null);
    try {
      const h = await Api.health();
      if (!h.glpi.configured) setMsg({ kind: "error", text: "GLPI non configuré." });
      else if (h.glpi.reachable)
        setMsg({ kind: "success", text: "Connexion GLPI OK (joignable)." });
      else setMsg({ kind: "error", text: "GLPI injoignable (URL/token/SSL ?)." });
      health.reload();
    } finally {
      setTesting(false);
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
            hint={
              c?.glpi_user_token_set ? "Déjà configuré — laisser vide pour conserver." : undefined
            }
          >
            <Input
              type="password"
              placeholder="(inchangé)"
              onChange={(e) => set("glpi_user_token", e.target.value)}
            />
          </Field>
          <Field
            label="App token (optionnel)"
            hint={
              c?.glpi_app_token_set ? "Déjà configuré — laisser vide pour conserver." : undefined
            }
          >
            <Input
              type="password"
              placeholder="(inchangé)"
              onChange={(e) => set("glpi_app_token", e.target.value)}
            />
          </Field>

          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={verifyTls}
              onChange={(e) => setVerifyTls(e.target.checked)}
            />
            Vérifier le certificat TLS (décocher pour un certificat auto-signé)
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={legacy9x}
              onChange={(e) => setLegacy9x(e.target.checked)}
            />
            GLPI 9.x (suivis via <code className="mx-1">TicketFollowup</code> au lieu de{" "}
            <code className="ml-1">ITILFollowup</code> en 10.x+)
          </label>

          <div className="flex gap-2">
            <Button onClick={save}>Enregistrer</Button>
            <Button variant="outline" onClick={testConnection} disabled={testing}>
              {testing ? "Test…" : "Tester la connexion"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
