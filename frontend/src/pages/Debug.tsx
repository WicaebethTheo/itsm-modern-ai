import { Banner, PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
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
  const status = useResource(useCallback(() => Api.debugStatus(), []));
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
      const p = (e as { payload?: { detail?: { message?: string } } }).payload;
      setErr(p?.detail?.message ?? (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <PageHeader
        title="Debug & tests"
        description="Diagnostics et jeux de données de test. Réservé au labo — désactivé en production."
      />

      {!enabled && (
        <div className="mb-4">
          <Banner kind="warning">
            Outils désactivés. Active <code>DEBUG_TOOLS_ENABLED=true</code> pour les utiliser.
          </Banner>
        </div>
      )}
      {err && (
        <div className="mb-4">
          <Banner kind="error">{err}</Banner>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {/* Diagnostics */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Diagnostics</CardTitle>
            <Button
              variant="outline"
              disabled={!enabled || busy === "diag"}
              onClick={() => wrap("diag", async () => setDiag(await Api.debugDiagnostics()))}
            >
              {busy === "diag" ? "…" : "Lancer les diagnostics"}
            </Button>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Vérifie GLPI (auth, référentiels, tickets) et le LLM (clé, sonde).
            </p>
            {diag != null && <J data={diag} />}
          </CardContent>
        </Card>

        {/* Seed */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4" /> Jeu de données de test
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Crée de faux techniciens (profil Technician) et groupes assignables dans GLPI.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Techniciens">
                <Input
                  type="number"
                  min="0"
                  max="50"
                  value={techs}
                  onChange={(e) => setTechs(Number(e.target.value))}
                />
              </Field>
              <Field label="Groupes">
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
                {busy === "seed" ? "Création…" : "Créer les faux comptes"}
              </Button>
            </div>
            {seedRes != null && <J data={seedRes} />}
          </CardContent>
        </Card>

        {/* Purge — destructif */}
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" /> Zone dangereuse — purge des utilisateurs
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Banner kind="error">
              Supprime (corbeille GLPI, récupérable) <strong>tous les utilisateurs</strong> sauf les
              comptes protégés (système, <code>glpi</code>, et l'utilisateur du token API). À
              n'utiliser qu'en labo. Tape <strong>SUPPRIMER</strong> pour confirmer.
            </Banner>
            <Field label="Confirmation">
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
                {busy === "purge" ? "Suppression…" : "Purger les utilisateurs"}
              </Button>
            </div>
            {purgeRes != null && <J data={purgeRes} />}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
