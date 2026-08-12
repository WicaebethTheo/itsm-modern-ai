import { AlertTriangle, ClipboardCopy, FlaskConical, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag, type TagTone } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api, type Health, type VersionInfo } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type T = (fr: string, en: string) => string;

/**
 * Page de diagnostic — deux moitiés qu'il ne faut PAS confondre :
 *
 * 1. « État de l'instance » : lu via `/health` + `/api/version`, qui ne dépendent d'AUCUN
 *    réglage. C'est la seule partie qui répond encore quand `DEBUG_TOOLS_ENABLED` est
 *    faux (le défaut). Sans elle, la page qu'on ouvre quand « ça ne marche pas » serait
 *    vide : `/api/debug/info` est gardé, son 403 n'est même pas rendu.
 * 2. Les outils de labo, gatés par ce réglage — et dont DEUX ÉCRIVENT dans le GLPI de
 *    production (création de faux comptes, suppression d'utilisateurs). D'où les deux
 *    intertitres : ce qui lit et ce qui écrit ne se mélangent pas.
 *
 * Ce que la page rend n'est jamais un secret : des booléens, des compteurs, des chemins
 * de routes et des messages d'erreur déjà masqués côté moteur. En revanche le masquage
 * laisse passer les IP et noms d'hôtes internes — c'est le diagnostic lui-même — et
 * c'est exactement ce que dit la légende sous le rapport.
 */

function J({ data, label }: { data: unknown; label: string }) {
  return (
    <>
      <p className="text-caption font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      {/* Hauteur bornée : un résultat de purge peut faire des centaines de lignes et
          repousser tout le reste de la page hors de l'écran. */}
      <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/50 p-3 text-body">
        {JSON.stringify(data, null, 2)}
      </pre>
    </>
  );
}

function SectionTitle({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return (
    <h2
      className={cn(
        "mt-2 flex items-center gap-1.5 text-caption font-medium uppercase tracking-[0.08em]",
        warn ? "text-warning" : "text-muted-foreground",
      )}
    >
      {warn && <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
      {children}
    </h2>
  );
}

interface StateView {
  tone: TagTone;
  state: string;
  detail: string;
}

function glpiView(h: Health | null, t: T): StateView {
  if (!h) {
    return {
      tone: "muted",
      state: t("Inconnu", "Unknown"),
      detail: t("État non reçu du moteur.", "State not received from the engine."),
    };
  }
  if (!h.glpi.configured) {
    return {
      tone: "muted",
      state: t("Non configuré", "Not configured"),
      detail: t("Aucune connexion GLPI enregistrée.", "No GLPI connection recorded."),
    };
  }
  if (!h.glpi.reachable) {
    return {
      tone: "red",
      state: t("Injoignable", "Unreachable"),
      detail: t(
        "Configuré, mais le moteur n'obtient pas de réponse.",
        "Configured, but the engine gets no answer.",
      ),
    };
  }
  return {
    tone: "green",
    state: t("Joignable", "Reachable"),
    detail: h.glpi.version
      ? `GLPI ${h.glpi.version}`
      : t("Version non annoncée par GLPI.", "Version not advertised by GLPI."),
  };
}

function llmView(h: Health | null, t: T): StateView {
  if (!h) {
    return {
      tone: "muted",
      state: t("Inconnu", "Unknown"),
      detail: t("État non reçu du moteur.", "State not received from the engine."),
    };
  }
  if (!h.llm.configured) {
    return {
      tone: "muted",
      state: t("Non configuré", "Not configured"),
      detail: t("Aucun fournisseur IA enregistré.", "No AI provider recorded."),
    };
  }
  // `reachable === null` = LE MOTEUR N'A PAS SONDÉ (le sondage coûte un appel payant).
  // Le confondre avec une panne ferait chercher une panne qui n'existe pas.
  if (h.llm.reachable == null) {
    return {
      tone: "indigo",
      state: t("Non sondé", "Not probed"),
      detail: t(
        "Configuré. Le moteur ne contacte pas le fournisseur à chaque contrôle de santé : ce n'est pas une panne.",
        "Configured. The engine does not contact the provider on every health check: this is not a failure.",
      ),
    };
  }
  if (!h.llm.reachable) {
    return {
      tone: "red",
      state: t("Injoignable", "Unreachable"),
      detail: t(
        "Configuré, mais la sonde a échoué (clé, quota ou réseau).",
        "Configured, but the probe failed (key, quota or network).",
      ),
    };
  }
  return {
    tone: "green",
    state: t("Joignable", "Reachable"),
    detail: t("Sonde réussie.", "Probe succeeded."),
  };
}

function StateRow({ name, view }: { name: string; view: StateView }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/50 py-2.5 first:pt-0 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-body font-medium leading-tight">{name}</p>
        <p className="mt-0.5 text-caption leading-snug text-muted-foreground">{view.detail}</p>
      </div>
      <Tag tone={view.tone}>{view.state}</Tag>
    </div>
  );
}

/**
 * Rapport texte à coller dans une issue ou un ticket de support. Aucun jeton, aucune
 * clé : uniquement ce que la page affiche déjà (les messages d'erreur sont masqués par
 * le moteur avant d'arriver ici).
 */
function buildReport(
  t: T,
  health: Health | null,
  healthError: string | null,
  version: VersionInfo | null,
  toolsEnabled: boolean | null,
  diag: unknown,
): string {
  const glpi = glpiView(health, t);
  const llm = llmView(health, t);
  const lines = [
    "ITSM Modern AI — diagnostic",
    `${t("Généré le", "Generated at")} : ${new Date().toISOString()}`,
    `${t("Version", "Version")} : ${version?.current ?? "?"}`,
    `${t("Dernière publiée", "Latest published")} : ${version?.latest ?? t("inconnue", "unknown")}`,
    `${t("Exécution", "Runtime")} : ${version?.runtime ?? "?"}`,
    `${t("Santé globale", "Overall health")} : ${health?.status ?? healthError ?? "?"}`,
    `GLPI : ${glpi.state} — ${glpi.detail}`,
    `${t("Fournisseur IA", "AI provider")} : ${llm.state} — ${llm.detail}`,
    `${t("Outils de laboratoire", "Lab tools")} : ${
      toolsEnabled == null
        ? t("inconnu", "unknown")
        : toolsEnabled
          ? t("activés", "enabled")
          : t("désactivés", "disabled")
    }`,
    `${t("Diagnostic détaillé", "Detailed diagnostics")} : ${
      diag == null ? t("non lancé", "not run") : `\n${JSON.stringify(diag, null, 2)}`
    }`,
  ];
  return lines.join("\n");
}

export function Debug() {
  const t = useT();
  const toast = useToast();
  // Santé et version ne dépendent d'AUCUN réglage : c'est ce qui reste lisible quand les
  // outils de labo sont coupés (le cas normal en production).
  const health = useResource(useCallback(() => Api.health(), []));
  const version = useResource(useCallback(() => Api.version(), []));
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
  // Ne montrer « Outils désactivés » que sur une réponse réelle (enabled=false) :
  // un GET en échec doit remonter l'erreur, pas se faire passer pour un flag désactivé.
  const disabledKnown = status.data != null && !status.data.enabled;

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

  async function copyReport() {
    const report = buildReport(
      t,
      health.data,
      health.error,
      version.data,
      status.data?.enabled ?? null,
      diag,
    );
    try {
      await navigator.clipboard.writeText(report);
      toast.success(t("Rapport copié.", "Report copied."));
    } catch {
      toast.error(t("Copie impossible — copiez manuellement.", "Copy failed — copy manually."));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {status.error && (
        <Banner kind="error">
          {t("État des outils indisponible :", "Tools status unavailable:")} {status.error}
        </Banner>
      )}
      {err && <Banner kind="error">{err}</Banner>}

      <SectionTitle>{t("Lecture seule", "Read-only")}</SectionTitle>

      {/* État de l'instance — INDÉPENDANT de DEBUG_TOOLS_ENABLED. */}
      <Card>
        <PanelHead
          title={t("État de l'instance", "Instance state")}
          subtitle={t(
            "Lu sans aucun réglage à activer — disponible même outils coupés",
            "Read without any setting to enable — available even with the tools off",
          )}
          right={
            <Button variant="outline" size="sm" onClick={copyReport}>
              <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
              {t("Copier le rapport", "Copy report")}
            </Button>
          }
        />
        <CardContent>
          {health.error && (
            <div className="mb-3">
              <Banner kind="error">
                {t("Santé indisponible :", "Health unavailable:")} {health.error}
              </Banner>
            </div>
          )}
          <div className="flex flex-col">
            <StateRow name="GLPI" view={glpiView(health.data, t)} />
            <StateRow name={t("Fournisseur IA", "AI provider")} view={llmView(health.data, t)} />
            <StateRow
              name={t("Moteur", "Engine")}
              view={{
                tone: version.data ? "green" : "muted",
                state: version.data ? `v${version.data.current}` : t("Inconnu", "Unknown"),
                detail: version.data
                  ? `${t("Exécution", "Runtime")} : ${version.data.runtime}${
                      version.data.latest
                        ? ` · ${t("dernière publiée", "latest published")} v${version.data.latest}`
                        : ""
                    }`
                  : t("Version non reçue du moteur.", "Version not received from the engine."),
              }}
            />
          </div>
          <p className="mt-4 text-caption leading-snug text-muted-foreground">
            {t(
              "Ce rapport ne contient aucun jeton ni clé d'API : le moteur les masque avant de les journaliser. Il peut en revanche contenir vos adresses internes (IP, noms d'hôtes) — relisez-le avant de le publier ailleurs qu'en support privé.",
              "This report contains no token and no API key: the engine masks them before logging. It can however contain your internal addresses (IPs, host names) — read it through before posting it anywhere other than private support.",
            )}
          </p>
        </CardContent>
      </Card>

      {disabledKnown && (
        <Banner kind="warning">
          {t(
            "Outils de laboratoire désactivés. Pour les activer, ajoutez ",
            "Lab tools disabled. To enable them, add ",
          )}
          <code>DEBUG_TOOLS_ENABLED=true</code>
          {t(
            " au fichier .env du déploiement, puis relancez le conteneur (docker compose up -d) : c'est un réglage de déploiement, il n'est pas modifiable depuis l'interface et n'est relu qu'au démarrage. L'état de l'instance ci-dessus reste consultable sans cela.",
            " to the deployment's .env file, then restart the container (docker compose up -d): this is a deployment setting, it cannot be changed from the interface and is only read at startup. The instance state above stays readable without it.",
          )}
        </Banner>
      )}

      {/* Diagnostics — lecture seule dans GLPI (auth, référentiels, comptage). */}
      <Card>
        <PanelHead
          title={t("Diagnostics", "Diagnostics")}
          subtitle={t(
            "Vérifie GLPI (auth, référentiels, tickets) et le LLM (clé, sonde) — aucune écriture",
            "Checks GLPI (auth, referentials, tickets) and the LLM (key, probe) — no writes",
          )}
          right={
            <Button
              variant="outline"
              size="sm"
              disabled={!enabled || busy === "diag"}
              onClick={() => wrap("diag", async () => setDiag(await Api.debugDiagnostics()))}
            >
              {busy === "diag"
                ? t("Diagnostic en cours…", "Running diagnostics…")
                : t("Lancer le diagnostic", "Run diagnostics")}
            </Button>
          }
        />
        {/* Le conteneur live PRÉEXISTE au résultat : une région ajoutée en même temps
            que son contenu n'est pas annoncée. Sans résultat, il ne prend aucune place. */}
        <div aria-live="polite" className={diag != null ? "p-5" : ""}>
          {diag != null && (
            <J data={diag} label={t("Résultat du diagnostic", "Diagnostics result")} />
          )}
        </div>
      </Card>

      {/* Informations & routes exposées — lecture seule, gaté par le réglage. */}
      {info.data && (
        <Card>
          <PanelHead
            title={t("Informations", "Information")}
            right={<Tag tone="muted">v{info.data.version}</Tag>}
          />
          <CardContent>
            <p className="text-body text-muted-foreground">{info.data.title}</p>
            {/* Repliée : ~60 lignes en haut de page pour une information consultée une
                fois par an, ce n'est pas ce qu'on vient chercher ici. */}
            <details className="mt-3 rounded-md border border-border">
              <summary className="cursor-pointer select-none px-3 py-2 text-body text-muted-foreground hover:text-foreground">
                {t("Routes exposées", "Exposed routes")} ({info.data.endpoints.length})
              </summary>
              <div className="max-h-72 overflow-auto border-t border-border font-mono">
                {info.data.endpoints.map((e) => (
                  <div
                    key={e.path}
                    className="flex items-center gap-3 border-b border-border/50 px-3 py-1.5 text-body last:border-0"
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
            </details>
          </CardContent>
        </Card>
      )}

      <SectionTitle warn>{t("Écrit dans votre GLPI", "Writes to your GLPI")}</SectionTitle>
      <p className="-mt-2 text-caption leading-snug text-muted-foreground">
        {t(
          "Les deux outils ci-dessous modifient le GLPI branché sur ce moteur — celui de production si c'est celui que vous avez configuré. À réserver à une instance de laboratoire.",
          "The two tools below modify the GLPI wired to this engine — the production one if that is what you configured. Reserve them for a lab instance.",
        )}
      </p>

      {/* Seed — ÉCRIT dans GLPI : crée de vrais comptes. */}
      <Card className="border-warning/40">
        <PanelHead
          title={
            <span className="flex items-center gap-2 text-warning">
              <FlaskConical className="h-4 w-4" /> {t("Jeu de données de test", "Test dataset")}
            </span>
          }
          subtitle={t(
            "Crée de VRAIS comptes techniciens et groupes dans votre GLPI",
            "Creates REAL technician accounts and groups in your GLPI",
          )}
        />
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("Techniciens", "Technicians")} htmlFor="debug-techs">
              <Input
                id="debug-techs"
                type="number"
                min="0"
                max="50"
                value={techs}
                // Vider le champ produit NaN — envoyé tel quel, le moteur reçoit `null`.
                // On borne à la source, dans les mêmes limites que min/max.
                onChange={(e) => setTechs(clampCount(e.target.value))}
              />
            </Field>
            <Field label={t("Groupes", "Groups")} htmlFor="debug-groups">
              <Input
                id="debug-groups"
                type="number"
                min="0"
                max="50"
                value={groups}
                onChange={(e) => setGroups(clampCount(e.target.value))}
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
          <div aria-live="polite">
            {seedRes != null && <J data={seedRes} label={t("Comptes créés", "Accounts created")} />}
          </div>
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
        <CardContent className="flex flex-col gap-4">
          <Banner kind="error">
            {t(
              "Supprime (corbeille GLPI, récupérable) tous les utilisateurs sauf les comptes protégés (système, glpi, et l'utilisateur du token API). À n'utiliser qu'en labo. Tapez SUPPRIMER pour confirmer.",
              "Soft-deletes (GLPI trash, recoverable) all users except protected accounts (system, glpi, and the API token user). Lab use only. Type SUPPRIMER to confirm.",
            )}
          </Banner>
          <Field label={t("Confirmation", "Confirmation")} htmlFor="debug-confirm">
            <Input
              id="debug-confirm"
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
          <div aria-live="polite">
            {purgeRes != null && (
              <J data={purgeRes} label={t("Résultat de la purge", "Purge result")} />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Borne la saisie numérique : un champ vidé vaut 0, jamais NaN. */
function clampCount(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(50, Math.max(0, n));
}
