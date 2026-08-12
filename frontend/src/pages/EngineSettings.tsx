import {
  Activity,
  BarChart3,
  MessageSquareText,
  ShieldCheck,
  ShieldHalf,
  Sliders,
  Terminal,
  Timer,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LockedBadge } from "@/components/ui/LockedBadge";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag, type TagTone } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/useResource";
import { Api, asBool, type ConfigUpdate, type ConfigView, type ExecutionMode } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const SYS_MAX = 8000;

/**
 * Couleur du marqueur de mode : neutre → amber → rouge selon l'autonomie accordée.
 * Table RECOPIÉE de `pages/Scope.tsx` (et non importée : une page n'est pas un module
 * partagé) — les deux vues règlent le même réglage, elles doivent en donner la même
 * lecture visuelle.
 */
const MODE_TONE: Record<ExecutionMode, TagTone> = {
  suggestion: "muted",
  semi_auto: "amber",
  full_auto: "red",
};

/** Réglages numériques de la page + valeur affichée en placeholder si la clé est vide. */
const NUM_DEFAULTS = {
  confidence_threshold: "0.7",
  cost_cap_eur_per_day: "5",
  llm_retries: "1",
  auto_min_confidence_default: "0.9",
  polling_interval_seconds: "60",
  dashboard_window_days: "7",
  anomaly_new_age_hours: "24",
} as const;

type NumKey = keyof typeof NUM_DEFAULTS;
const NUM_KEYS = Object.keys(NUM_DEFAULTS) as NumKey[];

/**
 * Brouillon COMPLET de la page (motif éprouvé dans `pages/Automations.tsx`) : chaque
 * contrôle est piloté par cet objet, initialisé depuis la config chargée. Avant, les
 * valeurs réelles n'étaient que des `placeholder` — un champ « vide » en gris clair, qu'on
 * ne pouvait distinguer d'une suggestion. Le brouillon donne aussi l'état « modifié »
 * (comparaison avec la config enregistrée) sans état supplémentaire.
 */
interface Draft {
  nums: Record<NumKey, string>;
  pollingOn: boolean;
  sysPrompt: string;
  mask: { email: boolean; phone: boolean; iban: boolean; secret: boolean };
  mode: ExecutionMode;
  tone: string;
  assistant: string;
  routing: string;
}

function toDraft(c: ConfigView | null): Draft {
  const nums = {} as Record<NumKey, string>;
  for (const k of NUM_KEYS) nums[k] = c?.[k] ?? "";
  return {
    nums,
    // Tant que la config n'est pas chargée : défauts sûrs (polling ON, masques ON).
    pollingOn: c ? asBool(c.polling_enabled) : true,
    sysPrompt: c?.system_prompt ?? "",
    mask: {
      email: c ? asBool(c.mask_email) : true,
      phone: c ? asBool(c.mask_phone) : true,
      iban: c ? asBool(c.mask_iban) : true,
      secret: c ? asBool(c.mask_secret) : true,
    },
    mode: (c?.execution_mode_default as ExecutionMode) || "suggestion",
    tone: c?.response_tone ?? "",
    assistant: c?.assistant_name ?? "",
    routing: c?.routing_rules ?? "",
  };
}

/** Titre de section — sépare visuellement les groupes de cartes. */
function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-2 text-muted-foreground">
      <span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
      <h2 className="text-caption font-medium uppercase tracking-[0.08em]">{children}</h2>
    </div>
  );
}

/** En-tête de carte avec une icône à gauche du titre. */
function HeadTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      {children}
    </span>
  );
}

export function EngineSettings() {
  const t = useT();
  const toast = useToast();
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const [draft, setDraft] = useState<Draft>(() => toDraft(null));
  const [saving, setSaving] = useState(false);
  const c = cfg.data;
  // Référence = la config ENREGISTRÉE. Sert au calcul de « modifié » et à la décision de
  // confirmation (on confirme le franchissement suggestion → écriture, pas un aller-retour).
  const saved = useMemo(() => toDraft(c), [c]);
  // Masquage IBAN + secrets = feature Supporter (FEATURE_PII_ADVANCED). En Community,
  // ces motifs sont verrouillés et NON masqués (envoyés en clair) → bandeau d'alerte.
  const license = useResource(useCallback(() => Api.getLicense(), []));
  const piiAdvanced =
    (license.data?.features ?? []).find((f) => f.key === "pii_advanced")?.active ?? false;

  useEffect(() => {
    if (c) setDraft(toDraft(c));
  }, [c]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  function setNum(k: NumKey, v: string) {
    setDraft((d) => ({ ...d, nums: { ...d.nums, [k]: v } }));
  }
  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  const modeLabel = (m: ExecutionMode) =>
    m === "suggestion"
      ? t("Suggestion", "Suggestion")
      : m === "semi_auto"
        ? t("Semi-auto", "Semi-auto")
        : t("Full-auto", "Full-auto");

  // `domain/modes.resolve_action()` mute GLPI en semi_auto DÈS que la confiance dépasse le
  // seuil : le bandeau ne peut pas être réservé à full_auto (c'est ce que fait déjà Scope).
  const writes = draft.mode !== "suggestion";
  // Le franchissement qui ARME l'écriture : enregistré en suggestion, brouillon au-delà.
  const armsWrites = saved.mode === "suggestion" && writes;

  // Seuil semi-auto sous le seuil de confiance = réglage sans effet : `engine.evaluate()`
  // a déjà renvoyé « à trier » avant que le mode ne soit consulté.
  const confNum = Number(draft.nums.confidence_threshold);
  const semiNum = Number(draft.nums.auto_min_confidence_default);
  const semiUseless =
    draft.nums.confidence_threshold !== "" &&
    draft.nums.auto_min_confidence_default !== "" &&
    Number.isFinite(confNum) &&
    Number.isFinite(semiNum) &&
    semiNum < confNum;

  async function save() {
    if (armsWrites) {
      const ok = window.confirm(
        t(
          `Passer le mode par défaut de « Suggestion » à « ${modeLabel(draft.mode)} » ?\n\nL'IA modifiera catégorie, priorité, assignation et répondra au demandeur, pour toute entité sans mode explicite.`,
          `Switch the default mode from “Suggestion” to “${modeLabel(draft.mode)}”?\n\nThe AI will modify category, priority, assignment and reply to the requester, for every entity without an explicit mode.`,
        ),
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      const nums: Partial<Record<NumKey, number>> = {};
      for (const k of NUM_KEYS) {
        const v = draft.nums[k];
        if (v !== "") nums[k] = Number(v);
      }
      const payload: ConfigUpdate = {
        ...nums,
        polling_enabled: draft.pollingOn,
        system_prompt: draft.sysPrompt,
        response_tone: draft.tone,
        assistant_name: draft.assistant,
        routing_rules: draft.routing,
        mask_email: draft.mask.email,
        mask_phone: draft.mask.phone,
        mask_iban: draft.mask.iban,
        mask_secret: draft.mask.secret,
        execution_mode_default: draft.mode,
      };
      await Api.updateConfig(payload);
      cfg.reload();
      toast.success(
        t(
          "Réglages enregistrés. L'intervalle de polling est appliqué immédiatement ; modes, seuils et plafond prennent effet au prochain cycle.",
          "Settings saved. The polling interval applies immediately; modes, thresholds and cap take effect on the next cycle.",
        ),
      );
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  // IBAN/secret comptent comme masqués seulement si la licence Supporter est active.
  const maskedCount = [
    draft.mask.email,
    draft.mask.phone,
    piiAdvanced && draft.mask.iban,
    piiAdvanced && draft.mask.secret,
  ].filter(Boolean).length;

  return (
    <div className="space-y-6">
      {/* GET config en échec : on prévient plutôt que de laisser un formulaire muet
          dont l'enregistrement écraserait la config réelle par les défauts locaux. */}
      {cfg.error && (
        <Banner kind="error">
          {t("Impossible de charger la configuration :", "Could not load the configuration:")}{" "}
          {cfg.error}
        </Banner>
      )}
      <div className="space-y-6">
        {/* ── Comportement du moteur ─────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionTitle icon={<Sliders />}>
            {t("Comportement du moteur", "Engine behaviour")}
          </SectionTitle>

          {/* Garde-fous */}
          <Card>
            <PanelHead
              title={<HeadTitle icon={<ShieldCheck />}>{t("Garde-fous", "Guardrails")}</HeadTitle>}
              subtitle={t(
                "Bornes de sécurité appliquées à chaque traitement",
                "Safety bounds applied to every run",
              )}
            />
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field
                htmlFor="cfg-confidence"
                label={t("Seuil de confiance (0 – 1)", "Confidence threshold (0 – 1)")}
                hint={t(
                  "Barrière d'entrée du moteur : en dessous, AUCUNE écriture — le ticket part « à trier » avec un Suivi privé « non tranché ». Repères : 0,5 permissif · 0,7 équilibré · 0,9 strict.",
                  "The engine's entry barrier: below it, NO write — the ticket goes “to triage” with a private “undecided” follow-up. Guides: 0.5 permissive · 0.7 balanced · 0.9 strict.",
                )}
              >
                <Input
                  id="cfg-confidence"
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={draft.nums.confidence_threshold}
                  placeholder={NUM_DEFAULTS.confidence_threshold}
                  onChange={(e) => setNum("confidence_threshold", e.target.value)}
                />
              </Field>
              <Field
                htmlFor="cfg-cost-cap"
                label={t("Plafond de coût (€/jour)", "Cost ceiling (€/day)")}
                hint={
                  <>
                    {t(
                      "Atteint, le moteur suspend les appels LLM facturables : tous les nouveaux tickets partent « à trier » jusqu'à la reprise de la fenêtre glissante de 24 h. 0 = pas de plafond, dépense non bornée.",
                      "Once reached, the engine pauses billable LLM calls: every new ticket goes “to triage” until the rolling 24h window frees up. 0 = no cap, unbounded spend.",
                    )}{" "}
                    <Link className="underline underline-offset-2 hover:text-foreground" to="/cost">
                      {t("Voir la consommation", "View consumption")}
                    </Link>
                  </>
                }
              >
                <Input
                  id="cfg-cost-cap"
                  type="number"
                  step="0.5"
                  min="0"
                  value={draft.nums.cost_cap_eur_per_day}
                  placeholder={NUM_DEFAULTS.cost_cap_eur_per_day}
                  onChange={(e) => setNum("cost_cap_eur_per_day", e.target.value)}
                />
              </Field>
              <Field
                htmlFor="cfg-retries"
                label={t("Tentatives LLM (retries)", "LLM retries")}
                hint={t(
                  "Nouvelles tentatives quand le LLM répond hors format. Épuisées, le ticket part « à trier ».",
                  "Retries when the LLM answers off-format. Once exhausted, the ticket goes “to triage”.",
                )}
              >
                <Input
                  id="cfg-retries"
                  type="number"
                  min="0"
                  max="5"
                  value={draft.nums.llm_retries}
                  placeholder={NUM_DEFAULTS.llm_retries}
                  onChange={(e) => setNum("llm_retries", e.target.value)}
                />
              </Field>
            </CardContent>
          </Card>

          {/* Mode d'exécution par défaut (FR-17) */}
          <Card>
            <PanelHead
              title={
                <HeadTitle icon={<ShieldHalf />}>
                  {t("Mode d'exécution par défaut", "Default execution mode")}
                </HeadTitle>
              }
              subtitle={t(
                "S'applique aux entités sans mode explicite. Réglable par entité dans « Règles métier ».",
                "Applies to entities without an explicit mode. Tunable per entity in “Business rules”.",
              )}
              right={<Tag tone={MODE_TONE[draft.mode]}>{modeLabel(draft.mode)}</Tag>}
            />
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  htmlFor="cfg-mode-default"
                  label={t("Mode par défaut", "Default mode")}
                  hint={t(
                    "suggestion : aucune écriture · semi/full-auto : applique la Décision et répond au demandeur.",
                    "suggestion: no write · semi/full-auto: applies the Decision and replies to the requester.",
                  )}
                >
                  <select
                    id="cfg-mode-default"
                    value={draft.mode}
                    onChange={(e) => patch({ mode: e.target.value as ExecutionMode })}
                    className="h-9 rounded-md border border-input bg-card px-3 text-ui shadow-sm transition-colors hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <option value="suggestion">{t("Suggestion (sûr)", "Suggestion (safe)")}</option>
                    <option value="semi_auto">
                      {t("Semi-auto (≥ seuil)", "Semi-auto (≥ threshold)")}
                    </option>
                    <option value="full_auto">Full-auto</option>
                  </select>
                </Field>
                <Field
                  htmlFor="cfg-semi-threshold"
                  label={t("Seuil du mode semi-auto (0 – 1)", "Semi-auto threshold (0 – 1)")}
                  hint={t(
                    "SECOND cran, appliqué après le seuil de confiance et uniquement en semi-auto : en dessous, la Décision n'est pas écrite dans GLPI, le ticket part « à trier » avec un Suivi privé « non tranché ». Repères : 0,5 permissif · 0,7 équilibré · 0,9 strict.",
                    "A SECOND gate, applied after the confidence threshold and only in semi-auto: below it the Decision is not written to GLPI, the ticket goes “to triage” with a private “undecided” follow-up. Guides: 0.5 permissive · 0.7 balanced · 0.9 strict.",
                  )}
                >
                  <Input
                    id="cfg-semi-threshold"
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={draft.nums.auto_min_confidence_default}
                    placeholder={NUM_DEFAULTS.auto_min_confidence_default}
                    onChange={(e) => setNum("auto_min_confidence_default", e.target.value)}
                  />
                </Field>
              </div>
              {semiUseless && (
                <Banner kind="warning">
                  {t(
                    `Le seuil semi-auto (${draft.nums.auto_min_confidence_default}) est inférieur au seuil de confiance (${draft.nums.confidence_threshold}) : il n'a aucun effet, le seuil de confiance tranche avant lui.`,
                    `The semi-auto threshold (${draft.nums.auto_min_confidence_default}) is below the confidence threshold (${draft.nums.confidence_threshold}): it has no effect, the confidence threshold already decides first.`,
                  )}
                </Banner>
              )}
              {writes && (
                <Banner kind={draft.mode === "full_auto" ? "error" : "warning"}>
                  {draft.mode === "full_auto"
                    ? t(
                        "⚠ full_auto par défaut : toute entité sans mode explicite modifiera les tickets GLPI (catégorie, priorité, assignation) et répondra au demandeur, sans second seuil.",
                        "⚠ full_auto by default: any entity without an explicit mode will modify GLPI tickets (category, priority, assignment) and reply to the requester, with no second gate.",
                      )
                    : t(
                        "⚠ semi_auto par défaut : toute entité sans mode explicite modifiera réellement les tickets GLPI (catégorie, priorité, assignation) et répondra au demandeur dès que la confiance dépasse le seuil semi-auto. Ce n'est PAS un mode d'observation.",
                        "⚠ semi_auto by default: any entity without an explicit mode will really modify GLPI tickets (category, priority, assignment) and reply to the requester as soon as confidence passes the semi-auto threshold. This is NOT an observation mode.",
                      )}
                </Banner>
              )}
            </CardContent>
          </Card>

          {/* Polling */}
          <Card>
            <PanelHead
              title={<HeadTitle icon={<Timer />}>{t("Polling", "Polling")}</HeadTitle>}
              subtitle={t(
                "Cadence d'ingestion des nouveaux tickets",
                "New-ticket ingestion cadence",
              )}
              right={
                <Tag tone={draft.pollingOn ? "green" : "muted"}>
                  {draft.pollingOn ? t("Activé", "Enabled") : t("Désactivé", "Disabled")}
                </Tag>
              }
            />
            <CardContent className="flex flex-col gap-4">
              <Toggle
                checked={draft.pollingOn}
                onChange={(v) => patch({ pollingOn: v })}
                label={t("Polling activé", "Polling enabled")}
                description={t(
                  "Le moteur traite les nouveaux tickets en continu.",
                  "The engine processes new tickets continuously.",
                )}
              />
              <Field
                htmlFor="cfg-polling-interval"
                label={t("Intervalle de polling (secondes)", "Polling interval (seconds)")}
                hint={t(
                  "Délai entre deux relevés des nouveaux tickets GLPI. Seul réglage de cette page appliqué IMMÉDIATEMENT à l'enregistrement (le planificateur est reprogrammé).",
                  "Delay between two sweeps of new GLPI tickets. The only setting on this page applied IMMEDIATELY on save (the scheduler is rescheduled).",
                )}
              >
                <Input
                  id="cfg-polling-interval"
                  type="number"
                  min="10"
                  value={draft.nums.polling_interval_seconds}
                  placeholder={NUM_DEFAULTS.polling_interval_seconds}
                  onChange={(e) => setNum("polling_interval_seconds", e.target.value)}
                />
              </Field>
            </CardContent>
          </Card>
        </section>

        {/* ── Suggestion & confidentialité ──────────────────────────────── */}
        <section className="space-y-3">
          <SectionTitle icon={<MessageSquareText />}>
            {t("Suggestion & confidentialité", "Suggestion & privacy")}
          </SectionTitle>

          {/* Qualité de la suggestion */}
          <Card>
            <PanelHead
              title={
                <HeadTitle icon={<MessageSquareText />}>
                  {t("Qualité de la suggestion", "Suggestion quality")}
                </HeadTitle>
              }
              subtitle={t(
                "Impacte le brouillon de réponse proposé (mode suggestion)",
                "Affects the proposed draft reply (suggestion mode)",
              )}
            />
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field htmlFor="cfg-tone" label={t("Ton de la réponse", "Reply tone")}>
                  <Input
                    id="cfg-tone"
                    value={draft.tone}
                    placeholder={t(
                      "professionnel, courtois et concis",
                      "professional, courteous and concise",
                    )}
                    onChange={(e) => patch({ tone: e.target.value })}
                  />
                </Field>
                <Field
                  htmlFor="cfg-assistant"
                  label={t(
                    "Nom de l'assistant (signature, optionnel)",
                    "Assistant name (signature, optional)",
                  )}
                >
                  <Input
                    id="cfg-assistant"
                    value={draft.assistant}
                    placeholder={t("Support IT", "IT Support")}
                    onChange={(e) => patch({ assistant: e.target.value })}
                  />
                </Field>
              </div>
              <Field
                htmlFor="cfg-routing"
                label={t(
                  "Consignes de routage (langage naturel, optionnel)",
                  "Routing guidance (natural language, optional)",
                )}
              >
                <Textarea
                  id="cfg-routing"
                  value={draft.routing}
                  placeholder={t(
                    "Ex. : les tickets mentionnant la paie vont à l'équipe RH ; les incidents sécurité sont prioritaires…",
                    "E.g.: tickets mentioning payroll go to HR; security incidents are priority…",
                  )}
                  onChange={(e) => patch({ routing: e.target.value })}
                />
              </Field>
            </CardContent>
          </Card>

          {/* Masquage des données sensibles (FR-14) */}
          <Card>
            <PanelHead
              title={
                <HeadTitle icon={<ShieldCheck />}>
                  {t("Masquage avant l'IA", "Masking before AI")}
                </HeadTitle>
              }
              subtitle={t(
                "Remplace les données sensibles par [EMAIL]/[IBAN]… AVANT l'envoi au LLM",
                "Replaces sensitive data with [EMAIL]/[IBAN]… BEFORE sending to the LLM",
              )}
              right={
                <Tag tone={maskedCount === 4 ? "green" : maskedCount === 0 ? "red" : "amber"}>
                  {maskedCount}/4
                </Tag>
              }
            />
            <CardContent className="flex flex-col gap-4">
              {piiAdvanced ? (
                <Banner kind="error">
                  {t(
                    "⚠ Désactiver un motif envoie cette donnée EN CLAIR au LLM — d'autant plus sensible si le fournisseur est hors UE (OpenAI, Anthropic). À valider avec la DPO.",
                    "⚠ Disabling a pattern sends that data IN CLEAR to the LLM — especially sensitive with a non-EU provider (OpenAI, Anthropic). Validate with the DPO.",
                  )}
                </Banner>
              ) : (
                <Banner kind="error">
                  {t(
                    "⚠ Édition Community : les IBAN et les secrets (mots de passe, tokens, clés API) ne sont PAS masqués et sont envoyés EN CLAIR au LLM. Activez votre licence Supporter pour les masquer.",
                    "⚠ Community edition: IBANs and secrets (passwords, tokens, API keys) are NOT masked and are sent IN CLEAR to the LLM. Activate your Supporter license to mask them.",
                  )}
                </Banner>
              )}
              <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
                <Toggle
                  checked={draft.mask.email}
                  onChange={(v) => patch({ mask: { ...draft.mask, email: v } })}
                  label={t("Masquer les e-mails", "Mask emails")}
                />
                <Toggle
                  checked={draft.mask.phone}
                  onChange={(v) => patch({ mask: { ...draft.mask, phone: v } })}
                  label={t("Masquer les téléphones", "Mask phone numbers")}
                />
                {piiAdvanced ? (
                  <Toggle
                    checked={draft.mask.iban}
                    onChange={(v) => patch({ mask: { ...draft.mask, iban: v } })}
                    label={t("Masquer les IBAN", "Mask IBANs")}
                  />
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ui text-muted-foreground">
                      {t("Masquer les IBAN", "Mask IBANs")}
                    </span>
                    <LockedBadge />
                  </div>
                )}
                {piiAdvanced ? (
                  <Toggle
                    checked={draft.mask.secret}
                    onChange={(v) => patch({ mask: { ...draft.mask, secret: v } })}
                    label={t("Masquer mots de passe / tokens", "Mask passwords / tokens")}
                  />
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ui text-muted-foreground">
                      {t("Masquer mots de passe / tokens", "Mask passwords / tokens")}
                    </span>
                    <LockedBadge />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── Observabilité ──────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionTitle icon={<BarChart3 />}>{t("Observabilité", "Observability")}</SectionTitle>

          {/* Dashboard inversé */}
          <Card>
            <PanelHead
              title={
                <HeadTitle icon={<Activity />}>
                  {t("Dashboard inversé", "Inverted dashboard")}
                </HeadTitle>
              }
              subtitle={t(
                "Fenêtre d'analyse et détection d'anomalies",
                "Analysis window and anomaly detection",
              )}
            />
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                htmlFor="cfg-window-days"
                label={t("Fenêtre (jours)", "Window (days)")}
                hint={t(
                  "Profondeur d'historique analysée par le Dashboard. Sans effet sur le triage.",
                  "History depth analysed by the Dashboard. No effect on triage.",
                )}
              >
                <Input
                  id="cfg-window-days"
                  type="number"
                  min="1"
                  max="365"
                  value={draft.nums.dashboard_window_days}
                  placeholder={NUM_DEFAULTS.dashboard_window_days}
                  onChange={(e) => setNum("dashboard_window_days", e.target.value)}
                />
              </Field>
              <Field
                htmlFor="cfg-anomaly-hours"
                label={t(
                  "Anomalie : âge max d'un ticket « New » (h)",
                  "Anomaly: max age of a “New” ticket (h)",
                )}
                hint={t(
                  "Au-delà de cette ancienneté, un ticket resté « New » est signalé comme anomalie. Signalement seul : aucune action sur le ticket.",
                  "Beyond this age, a ticket still “New” is flagged as an anomaly. Flagging only: no action on the ticket.",
                )}
              >
                <Input
                  id="cfg-anomaly-hours"
                  type="number"
                  min="1"
                  max="720"
                  value={draft.nums.anomaly_new_age_hours}
                  placeholder={NUM_DEFAULTS.anomaly_new_age_hours}
                  onChange={(e) => setNum("anomaly_new_age_hours", e.target.value)}
                />
              </Field>
            </CardContent>
          </Card>
        </section>

        {/* ── Avancé ─────────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionTitle icon={<Terminal />}>{t("Avancé", "Advanced")}</SectionTitle>

          {/* Prompt système */}
          <Card>
            <PanelHead
              title={
                <HeadTitle icon={<Terminal />}>
                  {t("Prompt système (avancé)", "System prompt (advanced)")}
                </HeadTitle>
              }
              subtitle={t(
                "Surcharge des instructions données au LLM",
                "Overrides the LLM instructions",
              )}
            />
            <CardContent className="flex flex-col gap-3">
              <p className="text-body text-muted-foreground">
                {t(
                  "Surcharge les instructions données au LLM. Vide = prompt par défaut. Le code valide toujours la Décision (whitelist, seuil) — modifier le prompt n'enlève aucun garde-fou.",
                  "Overrides the LLM instructions. Empty = built-in default. The code always validates the Decision (whitelist, threshold) — editing the prompt removes no guardrail.",
                )}
              </p>
              <Textarea
                id="cfg-system-prompt"
                aria-label={t("Prompt système", "System prompt")}
                className="min-h-48 font-mono text-body"
                value={draft.sysPrompt}
                maxLength={SYS_MAX}
                placeholder={c?.system_prompt_default ?? t("Prompt par défaut…", "Default prompt…")}
                onChange={(e) => patch({ sysPrompt: e.target.value })}
              />
              <div className="flex items-center justify-between text-caption text-muted-foreground">
                <span>
                  {draft.sysPrompt.length} / {SYS_MAX} {t("caractères", "characters")}
                  {draft.sysPrompt.trim() === ""
                    ? t(" — (défaut utilisé)", " — (default used)")
                    : ""}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => patch({ sysPrompt: "" })}
                >
                  {t("Réinitialiser au défaut", "Reset to default")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>

      {/* Barre d'enregistrement collante — bleed jusqu'aux bords du <main> (p-5/sm:p-6),
          reste visible en bas du conteneur défilant. */}
      <div
        className={cn(
          "sticky bottom-0 z-20 -mx-5 -mb-5 mt-2 border-t border-border bg-card/95 backdrop-blur",
          "supports-[backdrop-filter]:bg-card/80 sm:-mx-6 sm:-mb-6",
        )}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-3 sm:px-6">
          <p
            className={cn(
              "truncate text-body",
              armsWrites
                ? "font-medium text-destructive"
                : dirty
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
          >
            {armsWrites
              ? t(
                  "Modifications non enregistrées — dont le passage en écriture réelle dans GLPI.",
                  "Unsaved changes — including switching to real writes in GLPI.",
                )
              : dirty
                ? t("Modifications non enregistrées.", "Unsaved changes.")
                : t("Tout est enregistré.", "Everything is saved.")}
          </p>
          <Button onClick={save} disabled={!cfg.data || saving || !dirty}>
            {saving ? t("Enregistrement…", "Saving…") : t("Enregistrer", "Save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
