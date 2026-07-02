import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dot, type DotTone } from "@/components/ui/dot";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import {
  Api,
  type ConfigUpdate,
  DEMO,
  GLPI_AVATAR_URL,
  GLPI_OAUTH_SCOPES,
  type GlpiApiVersion,
  asBool,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { type ReactNode, useCallback, useEffect, useState } from "react";

export function GlpiConnection() {
  const t = useT();
  const toast = useToast();
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const health = useResource(useCallback(() => Api.health(), []));
  const account = useResource(useCallback(() => Api.glpiWhoami(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [verifyTls, setVerifyTls] = useState(true);
  const [legacy9x, setLegacy9x] = useState(false);
  const [apiVersion, setApiVersion] = useState<GlpiApiVersion>("legacy");
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [scopes, setScopes] = useState<Set<string>>(new Set(["api", "user"]));
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const c = cfg.data;
  useEffect(() => {
    if (c) {
      setVerifyTls(asBool(c.glpi_verify_tls));
      setLegacy9x(asBool(c.glpi_followup_legacy_9x));
      setApiVersion(c.glpi_api_version === "v2" ? "v2" : "legacy");
      const parsed = (c.glpi_oauth_scope ?? "")
        .split(/\s+/)
        .filter((s) => GLPI_OAUTH_SCOPES.includes(s as (typeof GLPI_OAUTH_SCOPES)[number]));
      setScopes(parsed.length > 0 ? new Set(parsed) : new Set(["api", "user"]));
    }
  }, [c]);

  const isV2 = apiVersion === "v2";

  function toggleScope(scope: string, next: boolean) {
    const ns = new Set(scopes);
    if (next) ns.add(scope);
    else ns.delete(scope);
    setScopes(ns); // updater pur ; l'effet de bord `set(...)` est sorti de setScopes
    set("glpi_oauth_scope", [...ns].sort().join(" "));
  }

  function set<K extends keyof ConfigUpdate>(k: K, v: ConfigUpdate[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    try {
      // On retire un éventuel scope « orphelin » du form (saisi en V2 puis bascule legacy)
      // et on ne le renvoie QUE si l'on est réellement en V2.
      const { glpi_oauth_scope: _scope, ...rest } = form;
      await Api.updateConfig({
        ...rest,
        ...(isV2 ? { glpi_oauth_scope: [...scopes].sort().join(" ") } : {}),
        glpi_api_version: apiVersion,
        glpi_verify_tls: verifyTls,
        glpi_followup_legacy_9x: legacy9x,
      });
      setForm({});
      cfg.reload();
      health.reload();
      account.reload();
      toast.success(t("Connexion GLPI enregistrée.", "GLPI connection saved."));
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    }
  }

  async function testConnection() {
    setTesting(true);
    try {
      const h = await Api.health();
      if (!h.glpi.configured) {
        const msg = t("GLPI non configuré.", "GLPI not configured.");
        toast.error(msg);
        setTestResult({ ok: false, msg });
      } else if (h.glpi.reachable) {
        const msg = t("GLPI joignable.", "GLPI reachable.");
        toast.success(t("Connexion GLPI OK (joignable).", "GLPI connection OK (reachable)."));
        setTestResult({ ok: true, msg });
      } else {
        const msg = t(
          "GLPI injoignable — vérifier l'URL, les identifiants et le certificat TLS.",
          "GLPI unreachable — check the URL, credentials and TLS certificate.",
        );
        toast.error(t("GLPI injoignable (URL/token/SSL ?).", "GLPI unreachable (URL/token/SSL?)."));
        setTestResult({ ok: false, msg });
      }
      health.reload();
      account.reload();
    } catch (e: unknown) {
      const msg = `${t("Échec du test", "Test failed")} : ${(e as Error).message}`;
      toast.error(msg);
      setTestResult({ ok: false, msg });
    } finally {
      setTesting(false);
    }
  }

  async function resetConnection() {
    if (
      !window.confirm(
        t("Réinitialiser toute la connexion GLPI ?", "Reset the whole GLPI connection?"),
      )
    )
      return;
    setResetting(true);
    try {
      await Api.resetGlpi();
      setForm({});
      setTestResult(null);
      cfg.reload();
      health.reload();
      account.reload();
      toast.success(t("Connexion GLPI réinitialisée.", "GLPI connection reset."));
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    } finally {
      setResetting(false);
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

  const segBtn = (active: boolean) =>
    `flex-1 rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
      active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <Card className="max-w-2xl">
      <PanelHead
        title={t("Paramètres de connexion", "Connection settings")}
        subtitle={
          isV2
            ? t(
                "API V2 high-level (OAuth2) — secrets chiffrés au repos, jamais réaffichés",
                "High-level V2 API (OAuth2) — secrets encrypted at rest, never shown again",
              )
            : t(
                "API legacy apirest.php — tokens chiffrés au repos, jamais réaffichés",
                "Legacy apirest.php API — tokens encrypted at rest, never shown again",
              )
        }
        right={
          <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
            {/* API réellement CONFIGURÉE (persistée), pas le sélecteur en cours d'édition. */}
            <Tag tone={c?.glpi_api_version === "v2" ? "amber" : "muted"}>
              {c?.glpi_api_version === "v2" ? t("API V2", "V2 API") : t("apirest", "apirest")}
            </Tag>
            <span className="flex items-center gap-1.5">
              <Dot tone={connTone} />
              {connLabel}
            </span>
          </span>
        }
      />
      <CardContent className="flex flex-col gap-4 p-5">
        {/* Aperçu LIVE : sous quel compte GLPI le bot agit (config enregistrée). */}
        {(() => {
          const a = account.data;
          const hasPhoto = !DEMO && !!a?.has_picture;

          // Corps de carte selon l'état (chargement / non configuré / indéterminé / ok).
          let body: ReactNode;
          if (account.loading && !a) {
            body = (
              <div className="flex items-center gap-3">
                <span className="size-11 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="flex flex-col gap-1.5">
                  <span className="h-3 w-28 animate-pulse rounded bg-muted" />
                  <span className="h-2.5 w-40 animate-pulse rounded bg-muted" />
                </div>
              </div>
            );
          } else if (a && !a.configured) {
            body = (
              <div className="flex items-center gap-3">
                <Avatar name={null} />
                <span className="text-[13px] text-muted-foreground">
                  {t("GLPI non configuré", "GLPI not configured")}
                </span>
              </div>
            );
          } else if (!a?.account) {
            body = (
              <div className="flex items-center gap-3">
                <Avatar name={null} />
                <span className="text-[13px] text-muted-foreground">
                  {t(
                    "Compte indéterminé — vérifier les identifiants",
                    "Account unknown — check the credentials",
                  )}
                </span>
              </div>
            );
          } else {
            body = (
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={a.account} src={hasPhoto ? GLPI_AVATAR_URL : null} alt={a.account} />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-semibold text-foreground">
                    {a.account}
                  </span>
                  <span className="truncate text-[12px] text-muted-foreground">
                    {a.profile}
                    {a.profile && a.username ? " · " : ""}
                    {a.username ? `@${a.username}` : ""}
                  </span>
                  {a.email ? (
                    <span className="truncate text-[11px] text-muted-foreground/80">{a.email}</span>
                  ) : null}
                </div>
              </div>
            );
          }

          return (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("Compte utilisé par le bot", "Account used by the bot")}
                  {a ? (
                    <Tag tone={a.api_version === "v2" ? "amber" : "muted"}>
                      {a.api_version === "v2" ? t("API V2 (Beta)", "V2 API (Beta)") : "apirest"}
                    </Tag>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="text-[12px] text-primary hover:underline disabled:opacity-50"
                  onClick={() => account.reload()}
                  disabled={account.loading}
                >
                  {account.loading ? t("Vérification…", "Checking…") : t("Rafraîchir", "Refresh")}
                </button>
              </div>
              {body}
            </div>
          );
        })()}

        <Field label={t("Version de l'API GLPI", "GLPI API version")}>
          <div className="flex gap-1 rounded-md border border-border bg-muted/40 p-1">
            <button type="button" className={segBtn(!isV2)} onClick={() => setApiVersion("legacy")}>
              {t("Legacy (apirest.php)", "Legacy (apirest.php)")}
            </button>
            <button type="button" className={segBtn(isV2)} onClick={() => setApiVersion("v2")}>
              <span className="inline-flex items-center gap-1.5">
                {t("API V2 (high-level OAuth2)", "V2 API (high-level OAuth2)")}
                <Tag tone="amber">{t("Beta", "Beta")}</Tag>
              </span>
            </button>
          </div>
        </Field>

        {isV2 ? (
          <Field label={t("URL de base (api.php/v2.3)", "Base URL (api.php/v2.3)")}>
            <Input
              key={`url-${apiVersion}`}
              defaultValue={c?.glpi_v2_base_url ?? ""}
              placeholder="https://glpi.exemple.local/api.php/v2.3"
              onChange={(e) => set("glpi_v2_base_url", e.target.value)}
            />
          </Field>
        ) : (
          <Field label={t("URL de base (apirest.php)", "Base URL (apirest.php)")}>
            <Input
              key={`url-${apiVersion}`}
              defaultValue={c?.glpi_base_url ?? ""}
              placeholder="https://glpi.exemple.local/apirest.php"
              onChange={(e) => set("glpi_base_url", e.target.value)}
            />
          </Field>
        )}

        {isV2 ? (
          <>
            <Field label={t("Client ID", "Client ID")}>
              <Input
                defaultValue={c?.glpi_oauth_client_id ?? ""}
                placeholder={t("Identifiant client OAuth2", "OAuth2 client ID")}
                onChange={(e) => set("glpi_oauth_client_id", e.target.value)}
              />
            </Field>
            <Field label={t("Identifiant (username)", "Username")}>
              <Input
                defaultValue={c?.glpi_oauth_username ?? ""}
                placeholder={t("Utilisateur GLPI", "GLPI user")}
                onChange={(e) => set("glpi_oauth_username", e.target.value)}
              />
            </Field>
            <Field
              label={t("Scopes OAuth", "OAuth scopes")}
              hint={t(
                "api = tickets/référentiels ; user = aperçu du compte. api + user recommandés.",
                "api = tickets/referentials; user = account preview. api + user recommended.",
              )}
            >
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border bg-muted/30 p-3">
                {GLPI_OAUTH_SCOPES.map((scope) => (
                  <Toggle
                    key={scope}
                    checked={scopes.has(scope)}
                    onChange={(next) => toggleScope(scope, next)}
                    label={scope}
                  />
                ))}
              </div>
            </Field>
            <Field
              label={t("Client secret", "Client secret")}
              hint={c?.glpi_oauth_client_secret_set ? keepHint : undefined}
            >
              <Input
                type="password"
                placeholder={t("(inchangé)", "(unchanged)")}
                onChange={(e) => set("glpi_oauth_client_secret", e.target.value)}
              />
            </Field>
            <Field
              label={t("Mot de passe", "Password")}
              hint={c?.glpi_oauth_password_set ? keepHint : undefined}
            >
              <Input
                type="password"
                placeholder={t("(inchangé)", "(unchanged)")}
                onChange={(e) => set("glpi_oauth_password", e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
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
          </>
        )}

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

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save}>{t("Enregistrer", "Save")}</Button>
          <Button variant="outline" onClick={testConnection} disabled={testing}>
            {testing ? t("Test…", "Testing…") : t("Tester la connexion", "Test connection")}
          </Button>
          <Button variant="outline" onClick={resetConnection} disabled={resetting}>
            {resetting ? t("Réinitialisation…", "Resetting…") : t("Réinitialiser", "Reset")}
          </Button>
          <span className="ml-1 text-[11px] text-muted-foreground">
            {t("Chiffré au repos (Fernet)", "Encrypted at rest (Fernet)")}
          </span>
        </div>

        {testResult ? (
          <div
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${
              testResult.ok
                ? "border-success/30 bg-success/10 text-success"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }`}
          >
            <Dot tone={testResult.ok ? "green" : "red"} className="mt-1" />
            <span>{testResult.msg}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
