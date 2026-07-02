import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AlertTriangle, FlaskConical, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

function J({ data }: { data: unknown }) {
  return (
    <pre className="mt-2 overflow-auto rounded-md bg-muted/50 p-3 text-xs">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export function Debug() {
  const t = useT();
  const status = useResource(useCallback(() => Api.debugStatus(), []));
  const info = useResource(useCallback(() => Api.debugInfo(), []));
  const [diag, setDiag] = useState<unknown>(null);
  const [seedRes, setSeedRes] = useState<unknown>(null);
  const [techs, setTechs] = useState(3);
  const [groups, setGroups] = useState(2);
  const [confirm, setConfirm] = useState("");
  const [purgeRes, setPurgeRes] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const enabled = status.data?.enabled ?? false;

  async function wrap(name: string, fn: () => Promise<void>) {
    setErr("");
    setBusy(name);
    try {
      await fn();
    } catch (e: unknown) {
      // ApiError porte déjà le message backend (detail.message) ou un libellé par status.
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!enabled && (
        <Banner kind="warning">
          {t("Outils désactivés. Active ", "Tools disabled. Set ")}
          <code>DEBUG_TOOLS_ENABLED=true</code>
          {t(" pour les utiliser.", " to use them.")}
        </Banner>
      )}
      {err && <Banner kind="error">{err}</Banner>}

      {/* Informations & endpoints */}
      {info.data && (
        <Card>
          <PanelHead
            title={t("Informations", "Information")}
            right={<Tag tone="muted">v{info.data.version}</Tag>}
          />
          <CardContent className="p-5">
            <p className="text-[12.5px] text-muted-foreground">{info.data.title}</p>
            <p className="mt-3 mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              {t("Endpoints exposés", "Exposed endpoints")} ({info.data.endpoints.length})
            </p>
            <div className="overflow-hidden rounded-md border border-border font-mono">
              {info.data.endpoints.map((e) => (
                <div
                  key={e.path}
                  className="flex items-center gap-3 border-b border-border/50 px-3 py-1.5 text-xs last:border-0"
                >
                  <span className="flex shrink-0 gap-1">
                    {e.methods.map((m) => (
                      <Tag key={m} tone={m === "GET" ? "green" : "indigo"}>
                        {m}
                      </Tag>
                    ))}
                  </span>
                  <code className="text-muted-foreground">{e.path}</code>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Diagnostics */}
      <Card>
        <PanelHead
          title={t("Diagnostics", "Diagnostics")}
          subtitle={t(
            "Vérifie GLPI (auth, référentiels, tickets) et le LLM (clé, sonde)",
            "Checks GLPI (auth, referentials, tickets) and the LLM (key, probe)",
          )}
          right={
            <Button
              variant="outline"
              size="sm"
              disabled={!enabled || busy === "diag"}
              onClick={() => wrap("diag", async () => setDiag(await Api.debugDiagnostics()))}
            >
              {busy === "diag" ? "…" : t("Lancer", "Run")}
            </Button>
          }
        />
        {diag != null && (
          <CardContent className="p-5">
            <J data={diag} />
          </CardContent>
        )}
      </Card>

      {/* Seed */}
      <Card>
        <PanelHead
          title={
            <span className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4" /> {t("Jeu de données de test", "Test dataset")}
            </span>
          }
          subtitle={t(
            "Crée de faux techniciens et groupes assignables dans GLPI",
            "Creates fake technicians and assignable groups in GLPI",
          )}
        />
        <CardContent className="flex flex-col gap-4 p-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("Techniciens", "Technicians")}>
              <Input
                type="number"
                min="0"
                max="50"
                value={techs}
                onChange={(e) => setTechs(Number(e.target.value))}
              />
            </Field>
            <Field label={t("Groupes", "Groups")}>
              <Input
                type="number"
                min="0"
                max="50"
                value={groups}
                onChange={(e) => setGroups(Number(e.target.value))}
              />
            </Field>
          </div>
          <div>
            <Button
              disabled={!enabled || busy === "seed"}
              onClick={() =>
                wrap("seed", async () => setSeedRes(await Api.debugSeed(techs, groups)))
              }
            >
              {busy === "seed"
                ? t("Création…", "Creating…")
                : t("Créer les faux comptes", "Create fake accounts")}
            </Button>
          </div>
          {seedRes != null && <J data={seedRes} />}
        </CardContent>
      </Card>

      {/* Purge — destructif */}
      <Card className="border-destructive/40">
        <PanelHead
          title={
            <span className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              {t("Zone dangereuse — purge des utilisateurs", "Danger zone — purge users")}
            </span>
          }
        />
        <CardContent className="flex flex-col gap-4 p-5">
          <Banner kind="error">
            {t(
              "Supprime (corbeille GLPI, récupérable) tous les utilisateurs sauf les comptes protégés (système, glpi, et l'utilisateur du token API). À n'utiliser qu'en labo. Tape SUPPRIMER pour confirmer.",
              "Soft-deletes (GLPI trash, recoverable) all users except protected accounts (system, glpi, and the API token user). Lab use only. Type SUPPRIMER to confirm.",
            )}
          </Banner>
          <Field label={t("Confirmation", "Confirmation")}>
            <Input
              value={confirm}
              placeholder="SUPPRIMER"
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <div>
            <Button
              variant="destructive"
              disabled={!enabled || confirm !== "SUPPRIMER" || busy === "purge"}
              onClick={() =>
                wrap("purge", async () => {
                  setPurgeRes(await Api.debugPurgeUsers(confirm));
                  setConfirm("");
                })
              }
            >
              <Trash2 className="h-4 w-4" />{" "}
              {busy === "purge"
                ? t("Suppression…", "Deleting…")
                : t("Purger les utilisateurs", "Purge users")}
            </Button>
          </div>
          {purgeRes != null && <J data={purgeRes} />}
        </CardContent>
      </Card>
    </div>
  );
}
