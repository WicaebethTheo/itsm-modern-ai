import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dot, type DotTone } from "@/components/ui/dot";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate, asBool } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";

export function GlpiConnection() {
  const t = useT();
  const toast = useToast();
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [verifyTls, setVerifyTls] = useState(true);
  const [legacy9x, setLegacy9x] = useState(false);
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
    try {
      await Api.updateConfig({
        ...form,
        glpi_verify_tls: verifyTls,
        glpi_followup_legacy_9x: legacy9x,
      });
      setForm({});
      cfg.reload();
      health.reload();
      toast.success(t("Connexion GLPI enregistrée.", "GLPI connection saved."));
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    }
  }

  async function testConnection() {
    setTesting(true);
    try {
      const h = await Api.health();
      if (!h.glpi.configured) toast.error(t("GLPI non configuré.", "GLPI not configured."));
      else if (h.glpi.reachable)
        toast.success(t("Connexion GLPI OK (joignable).", "GLPI connection OK (reachable)."));
      else
        toast.error(t("GLPI injoignable (URL/token/SSL ?).", "GLPI unreachable (URL/token/SSL?)."));
      health.reload();
    } finally {
      setTesting(false);
    }
  }

  const g = health.data?.glpi;
  const [connTone, connLabel]: [DotTone, string] = !g?.configured
    ? ["muted", t("Non configurée", "Not configured")]
    : g.reachable
      ? ["green", t("Connecté", "Connected")]
      : ["red", t("Injoignable", "Unreachable")];

  const keepHint = t(
    "Déjà configuré — laisser vide pour conserver.",
    "Already set — leave blank to keep.",
  );

  return (
    <Card className="max-w-2xl">
      <PanelHead
        title={t("Paramètres de connexion", "Connection settings")}
        subtitle={t(
          "API legacy apirest.php — tokens chiffrés au repos, jamais réaffichés",
          "Legacy apirest.php API — tokens encrypted at rest, never shown again",
        )}
        right={
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Dot tone={connTone} />
            {connLabel}
          </span>
        }
      />
      <CardContent className="flex flex-col gap-4 p-5">
        <Field label={t("URL de base (apirest.php)", "Base URL (apirest.php)")}>
          <Input
            defaultValue={c?.glpi_base_url ?? ""}
            placeholder="https://glpi.exemple.local/apirest.php"
            onChange={(e) => set("glpi_base_url", e.target.value)}
          />
        </Field>
        <Field
          label={t("User token", "User token")}
          hint={c?.glpi_user_token_set ? keepHint : undefined}
        >
          <Input
            type="password"
            placeholder={t("(inchangé)", "(unchanged)")}
            onChange={(e) => set("glpi_user_token", e.target.value)}
          />
        </Field>
        <Field
          label={t("App token (optionnel)", "App token (optional)")}
          hint={c?.glpi_app_token_set ? keepHint : undefined}
        >
          <Input
            type="password"
            placeholder={t("(inchangé)", "(unchanged)")}
            onChange={(e) => set("glpi_app_token", e.target.value)}
          />
        </Field>

        <Toggle
          checked={verifyTls}
          onChange={setVerifyTls}
          label={t("Vérifier le certificat TLS", "Verify TLS certificate")}
          description={t(
            "Décocher pour un certificat auto-signé.",
            "Turn off for a self-signed certificate.",
          )}
        />
        <Toggle
          checked={legacy9x}
          onChange={setLegacy9x}
          label={t("GLPI 9.x (suivis legacy)", "GLPI 9.x (legacy followups)")}
          description={t(
            "Suivis via TicketFollowup au lieu d'ITILFollowup (10.x+).",
            "Followups via TicketFollowup instead of ITILFollowup (10.x+).",
          )}
        />

        <div className="flex items-center gap-2">
          <Button onClick={save}>{t("Enregistrer", "Save")}</Button>
          <Button variant="outline" onClick={testConnection} disabled={testing}>
            {testing ? t("Test…", "Testing…") : t("Tester la connexion", "Test connection")}
          </Button>
          <span className="ml-1 text-[11px] text-muted-foreground">
            {t("Chiffré au repos (Fernet)", "Encrypted at rest (Fernet)")}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
