import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dot } from "@/components/ui/dot";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import {
  Api,
  type ConfigUpdate,
  type LlmProvider,
  type LlmTestResult,
  PROVIDER_LABELS,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type T = (fr: string, en: string) => string;

/**
 * Lecture du verdict de `POST /api/llm/test`. Chaque issue a son propre remède, et c'est
 * tout l'intérêt de ne pas les fondre dans un « échec du test » unique :
 * - `unreachable` : l'URL, la clé ou le réseau — rien n'est jamais parti ;
 * - `invalid_output` : le fournisseur répond, mais pas une Décision exploitable. Le moteur
 *   tournerait sans erreur apparente en envoyant TOUT « à trier » ; le remède est un autre
 *   modèle, pas une autre clé.
 */
export function readTestVerdict(
  r: LlmTestResult,
  t: T,
): { kind: "success" | "error" | "warning" | "info"; title: string; detail: string } {
  switch (r.stage) {
    case "ok":
      return {
        kind: "success",
        title: t(
          "Le modèle répond et sa sortie est exploitable.",
          "The model answers and its output is usable.",
        ),
        detail: t(
          "Un ticket de test a été soumis avec le prompt du produit : la Décision renvoyée est conforme au schéma attendu.",
          "A test ticket was submitted with the product prompt: the returned Decision matches the expected schema.",
        ),
      };
    case "not_configured":
      return {
        kind: "info",
        title: t("Aucune clé enregistrée.", "No key stored."),
        detail: t(
          "Renseignez la clé du fournisseur puis enregistrez avant de tester.",
          "Fill in the provider key and save before testing.",
        ),
      };
    case "unreachable":
      return {
        kind: "error",
        title: t("Le fournisseur n'a pas répondu.", "The provider did not answer."),
        detail: t(
          "Aucun appel n'a abouti : vérifiez l'URL de base, la clé et l'accès réseau depuis le conteneur.",
          "No call went through: check the base URL, the key and network access from the container.",
        ),
      };
    case "invalid_output":
      return {
        kind: "warning",
        title: t(
          "Le fournisseur répond, mais sa sortie n'est pas exploitable.",
          "The provider answers, but its output is not usable.",
        ),
        detail: t(
          "La réponse n'est pas une Décision conforme au schéma : en production, ces tickets partiraient tous « à trier » sans qu'aucune panne ne soit visible. Essayez un autre modèle.",
          "The answer is not a Decision matching the schema: in production those tickets would all fall back to « to triage » with no visible failure. Try another model.",
        ),
      };
    case "cost_cap_reached":
      return {
        kind: "warning",
        title: t("Plafond de coût atteint.", "Cost ceiling reached."),
        detail: t(
          "Aucun appel facturable n'est passé — le moteur non plus n'en passe plus. Relevez le plafond ou attendez que la fenêtre de 24 h glisse.",
          "No billable call was made — the engine is not making any either. Raise the cap or wait for the 24h window to slide.",
        ),
      };
    default:
      return {
        kind: "error",
        title: t("Le test a échoué.", "The test failed."),
        detail: t(
          "Le moteur n'a pas su qualifier l'échec ; le détail brut est ci-dessous.",
          "The engine could not qualify the failure; the raw detail is below.",
        ),
      };
  }
}

const PROVIDERS: LlmProvider[] = ["mistral", "openai", "ollama", "anthropic"];
const NON_SOVEREIGN: LlmProvider[] = ["openai", "anthropic"];
// Champs de `form` propres à chaque fournisseur — sert à purger au changement de
// sélection ce qui n'est plus affiché (jamais envoyer une clé/URL abandonnée).
const PROVIDER_KEYS: Record<LlmProvider, (keyof ConfigUpdate)[]> = {
  mistral: ["llm_base_url", "llm_model", "llm_api_key"],
  openai: ["openai_base_url", "openai_model", "openai_api_key"],
  ollama: ["ollama_base_url", "ollama_model"],
  anthropic: ["anthropic_base_url", "anthropic_model", "anthropic_api_key"],
};
const PROVIDER_DESC: Record<LlmProvider, { fr: string; en: string }> = {
  mistral: { fr: "souverain · UE", en: "sovereign · EU" },
  openai: { fr: "cloud · hors UE", en: "cloud · non-EU" },
  ollama: { fr: "local · aucune clé", en: "local · no key" },
  anthropic: { fr: "cloud · hors UE", en: "cloud · non-EU" },
};

export function AiProvider() {
  const t = useT();
  const toast = useToast();
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const [form, setForm] = useState<ConfigUpdate>({});
  const [provider, setProvider] = useState<LlmProvider>("mistral");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<LlmTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const c = cfg.data;
  useEffect(() => {
    if (c?.llm_provider) setProvider(c.llm_provider);
  }, [c?.llm_provider]);

  function set<K extends keyof ConfigUpdate>(k: K, v: ConfigUpdate[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Changement de fournisseur : purge de `form` les champs des AUTRES fournisseurs,
  // pour ne jamais envoyer une clé/URL saisie pour un fournisseur puis abandonné.
  function selectProvider(next: LlmProvider) {
    if (next === provider) return;
    setProvider(next);
    setTest(null); // un verdict porte sur UN fournisseur, jamais sur celui d'à côté
    setTestError(null);
    setForm((f) => {
      const copy = { ...f };
      for (const p of PROVIDERS) {
        if (p === next) continue;
        for (const k of PROVIDER_KEYS[p]) delete copy[k];
      }
      return copy;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await Api.updateConfig({ ...form, llm_provider: provider });
      setForm({});
      cfg.reload();
      // Le verdict précédent portait sur la configuration d'AVANT : le garder à l'écran
      // en ferait la validation de celle qu'on vient d'enregistrer.
      setTest(null);
      setTestError(null);
      toast.success(t("Fournisseur IA enregistré.", "AI provider saved."));
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTestError(null);
    try {
      setTest(await Api.testLlm());
    } catch (e: unknown) {
      setTest(null);
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  const fields: Record<
    LlmProvider,
    {
      baseKey: keyof ConfigUpdate;
      modelKey: keyof ConfigUpdate;
      secretKey: keyof ConfigUpdate | null;
      keySet: boolean;
      basePh: string;
      modelPh: string;
    }
  > = {
    mistral: {
      baseKey: "llm_base_url",
      modelKey: "llm_model",
      secretKey: "llm_api_key",
      keySet: !!c?.llm_api_key_set,
      basePh: "https://api.mistral.ai/v1",
      modelPh: "mistral-large-latest",
    },
    openai: {
      baseKey: "openai_base_url",
      modelKey: "openai_model",
      secretKey: "openai_api_key",
      keySet: !!c?.openai_api_key_set,
      basePh: "https://api.openai.com/v1",
      modelPh: "gpt-4o-mini",
    },
    ollama: {
      baseKey: "ollama_base_url",
      modelKey: "ollama_model",
      secretKey: null,
      keySet: false,
      basePh: "http://localhost:11434/v1",
      modelPh: "llama3.1",
    },
    anthropic: {
      baseKey: "anthropic_base_url",
      modelKey: "anthropic_model",
      secretKey: "anthropic_api_key",
      keySet: !!c?.anthropic_api_key_set,
      basePh: "https://api.anthropic.com",
      modelPh: "claude-sonnet-4-6",
    },
  };
  const f = fields[provider];
  const currentBase = (c?.[f.baseKey as keyof typeof c] as string) ?? "";
  const currentModel = (c?.[f.modelKey as keyof typeof c] as string) ?? "";

  // Fournisseur réellement opérationnel = sa clé est configurée (ollama : local, pas de clé).
  const isOperational = (p: LlmProvider) => (p === "ollama" ? true : fields[p].keySet);
  // Fournisseur « live » = celui ENREGISTRÉ côté moteur (c.llm_provider), pas l'état du sélecteur.
  const savedProvider = c?.llm_provider;
  // « Modifié, pas encore enregistré » — le changement de fournisseur compte : le moteur
  // répond toujours sur `savedProvider` tant que rien n'a été poussé.
  const dirty = Object.keys(form).length > 0 || (!!savedProvider && provider !== savedProvider);

  return (
    <div className="space-y-4">
      {/* GET config en échec : on prévient plutôt que d'afficher un formulaire muet
          dont l'enregistrement écraserait la config réelle par les défauts locaux. */}
      {cfg.error && (
        <Banner kind="error">
          {t("Impossible de charger la configuration :", "Could not load the configuration:")}{" "}
          {cfg.error}
        </Banner>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {PROVIDERS.map((p) => {
          const on = provider === p;
          // Le moteur tourne sur ce fournisseur ET sa clé est en place → live.
          const live = p === savedProvider && isOperational(p);
          // Enregistré mais clé manquante → actif mais non-opérationnel (amber, discret).
          const degraded = p === savedProvider && !isOperational(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => selectProvider(p)}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                on
                  ? "border-primary/50 bg-primary/10"
                  : "border-border bg-transparent hover:border-primary/30",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-ui font-medium">
                  {live && (
                    <span title={t("En service", "In service")} className="flex items-center">
                      <Dot tone="green" pulse />
                    </span>
                  )}
                  {degraded && (
                    <span
                      title={t("Actif — clé manquante", "Active — key missing")}
                      className="flex items-center"
                    >
                      <Dot tone="amber" />
                    </span>
                  )}
                  <span className="truncate">{PROVIDER_LABELS[p]}</span>
                </span>
                {on && <Tag tone="indigo">{t("Actif", "Active")}</Tag>}
              </div>
              <div className="mt-1.5 text-caption text-muted-foreground">
                {t(PROVIDER_DESC[p].fr, PROVIDER_DESC[p].en)}
              </div>
            </button>
          );
        })}
      </div>

      {NON_SOVEREIGN.includes(provider) && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-body text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t(
            `${PROVIDER_LABELS[provider]} est hors UE (non-souverain) — à valider avec la DPO.`,
            `${PROVIDER_LABELS[provider]} is outside the EU (non-sovereign) — to validate with the DPO.`,
          )}
        </div>
      )}
      {provider === "ollama" && (
        <p className="text-body text-muted-foreground">
          {t(
            "Modèle local : aucune donnée ne sort de votre infrastructure, aucune clé requise.",
            "Local model: no data leaves your infrastructure, no key required.",
          )}
        </p>
      )}

      <Card className="max-w-md">
        <PanelHead
          title={t("Configuration", "Configuration")}
          subtitle={PROVIDER_LABELS[provider]}
        />
        <CardContent className="flex flex-col gap-4">
          <Field label={t("URL de base", "Base URL")}>
            <Input
              key={`${provider}-base`}
              defaultValue={currentBase}
              placeholder={f.basePh}
              onChange={(e) => set(f.baseKey, e.target.value)}
            />
          </Field>
          <Field label={t("Modèle", "Model")}>
            <Input
              key={`${provider}-model`}
              defaultValue={currentModel}
              placeholder={f.modelPh}
              onChange={(e) => set(f.modelKey, e.target.value)}
            />
          </Field>
          {f.secretKey && (
            <Field
              label={t("Clé API", "API key")}
              hint={
                f.keySet ? (
                  <Tag tone="green">{t("configurée", "configured")}</Tag>
                ) : (
                  t("Non configurée", "Not configured")
                )
              }
            >
              {/* `autoComplete="new-password"` et un `name` explicite : sans eux le
                  navigateur propose d'enregistrer la clé API dans son gestionnaire de mots
                  de passe (avec synchronisation cloud) — une sortie du coffre Fernet par une
                  porte que le produit n'a jamais prévue. `"off"` ne convient pas : Chrome
                  documente cette valeur comme IGNORÉE sur un champ `type="password"`. */}
              <Input
                key={`${provider}-key`}
                name={`${provider}-api-key`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={t("(inchangée)", "(unchanged)")}
                onChange={(e) => set(f.secretKey as keyof ConfigUpdate, e.target.value)}
              />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} disabled={!cfg.data || saving}>
              {saving ? t("Enregistrement…", "Saving…") : t("Enregistrer", "Save")}
            </Button>
            {/* Le test porte sur la config ENREGISTRÉE (le moteur ne connaît pas le
                formulaire) : proposé seulement quand il n'y a plus rien à enregistrer,
                sinon son verdict vaudrait pour des réglages que l'admin vient de changer. */}
            <Button variant="outline" onClick={runTest} disabled={testing || dirty}>
              {testing
                ? t("Test en cours…", "Testing…")
                : t("Tester le fournisseur", "Test the provider")}
            </Button>
          </div>
          <p className="text-caption text-muted-foreground">
            {dirty
              ? t(
                  "Enregistrez d'abord : le test interroge la configuration enregistrée, pas ce formulaire.",
                  "Save first: the test queries the stored configuration, not this form.",
                )
              : t(
                  "Le test soumet un ticket fictif au modèle avec le prompt du produit et vérifie que la Décision renvoyée est exploitable. C'est un appel réel, facturé et journalisé.",
                  "The test submits a fake ticket to the model with the product prompt and checks that the returned Decision is usable. It is a real call, billed and journaled.",
                )}
          </p>

          <div aria-live="polite" className="empty:hidden">
            {testError && (
              <Banner kind="error" role="alert">
                {t("Échec du test :", "Test failed:")} {testError}
              </Banner>
            )}
            {test && <TestVerdict result={test} t={t} />}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Verdict du test + ce qu'il a coûté et obtenu (jamais un simple vert/rouge muet). */
function TestVerdict({ result, t }: { result: LlmTestResult; t: T }) {
  const v = readTestVerdict(result, t);
  const facts: string[] = [];
  if (result.model) facts.push(result.model);
  if (result.latency_ms != null) facts.push(`${result.latency_ms} ms`);
  if (result.prompt_tokens != null && result.completion_tokens != null) {
    facts.push(
      t(
        `${result.prompt_tokens} + ${result.completion_tokens} tokens`,
        `${result.prompt_tokens} + ${result.completion_tokens} tokens`,
      ),
    );
  }
  // Un coût nul est une INFORMATION (modèle local, aucune facturation) — pas une absence.
  if (result.cost_eur != null) facts.push(`${result.cost_eur.toFixed(4)} €`);
  return (
    <div className="flex flex-col gap-2">
      <Banner kind={v.kind}>
        <span className="font-medium">{v.title}</span> {v.detail}
      </Banner>
      {facts.length > 0 && (
        <p className="text-caption text-muted-foreground">{facts.join(" · ")}</p>
      )}
      {result.ok && result.priority != null && (
        <p className="text-caption text-muted-foreground">
          {t(
            `Sur le ticket de test, le modèle a proposé la catégorie ${result.category ?? "—"}, la priorité ${result.priority}, avec une confiance de ${result.confidence ?? "—"}.`,
            `On the test ticket, the model proposed category ${result.category ?? "—"}, priority ${result.priority}, with a confidence of ${result.confidence ?? "—"}.`,
          )}
        </p>
      )}
      {result.error && (
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-caption text-muted-foreground">
          {result.error}
        </pre>
      )}
    </div>
  );
}
