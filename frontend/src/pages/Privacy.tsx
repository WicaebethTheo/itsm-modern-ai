import { Clock, Eye, FileDown, Lock, ScrollText, ShieldCheck } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Banner } from "@/components/Banner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LockedBadge } from "@/components/ui/LockedBadge";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { Toggle } from "@/components/ui/toggle";
import { useConfigDraft } from "@/hooks/useConfigDraft";
import { useResource } from "@/hooks/useResource";
import {
  Api,
  asBool,
  type ConfigUpdate,
  type ConfigView,
  DEMO,
  DPO_REPORT_URL,
  type MaskTestOut,
  type PiiCategory,
  type PrivacyView,
} from "@/lib/api";
import { tr, useLang, useLocale, useT } from "@/lib/i18n";

// Texte d'exemple du testeur : traduit, sinon un utilisateur anglophone teste une
// phrase française (et n'y reconnaît pas ses propres motifs).
const MASK_EXAMPLE_FR =
  "Bonjour, je n'arrive plus à me connecter. Mon e-mail est jean.dupont@example.com " +
  "et le virement vers l'IBAN FR76 3000 4000 5000 0123 4567 890 est bloqué. Merci.";
const MASK_EXAMPLE_EN =
  "Hello, I can no longer sign in. My email is jean.dupont@example.com " +
  "and the transfer to IBAN FR76 3000 4000 5000 0123 4567 890 is blocked. Thanks.";

// Libellés des compteurs renvoyés par `Api.testMask` (clés de `domain/masking.mask`, plus
// celles déduites de la passe Supporter par `routes/privacy._added_placeholders`).
// Une clé inconnue reste affichée telle quelle : mieux vaut un libellé brut qu'un
// remplacement passé sous silence.
const COUNT_LABELS: Record<string, [string, string]> = {
  email: ["E-mails", "Emails"],
  phone: ["Téléphones", "Phone numbers"],
  iban: ["IBAN", "IBANs"],
  card: ["Cartes bancaires", "Payment cards"],
  secret: ["Secrets", "Secrets"],
  cloud_key: ["Clés cloud", "Cloud keys"],
  ip: ["Adresses IP", "IP addresses"],
  mac: ["Adresses MAC", "MAC addresses"],
  nir: ["NIR", "NIR"],
  siret: ["SIREN / SIRET", "SIREN / SIRET"],
};

/** En-tête de carte avec une icône à gauche du titre. */
function HeadTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      {children}
    </span>
  );
}

interface MaskDraft {
  email: boolean;
  phone: boolean;
  iban: boolean;
  secret: boolean;
}

/** Défauts SÛRS tant que la config n'est pas lue : on ne pré-affiche jamais « non masqué ». */
function toMaskDraft(c: ConfigView | null): MaskDraft {
  return {
    email: c ? asBool(c.mask_email) : true,
    phone: c ? asBool(c.mask_phone) : true,
    iban: c ? asBool(c.mask_iban) : true,
    secret: c ? asBool(c.mask_secret) : true,
  };
}

function toMaskPayload(d: MaskDraft): ConfigUpdate {
  return { mask_email: d.email, mask_phone: d.phone, mask_iban: d.iban, mask_secret: d.secret };
}

/**
 * Les bascules de masquage — le seul endroit du produit qui décide de ce qui SORT en clair.
 *
 * Elles vivaient sur la page « Moteur », au milieu de seize autres réglages : la page qui
 * explique le masquage à la DPO ne pouvait pas le changer, et celle qui le changeait portait
 * le nom le moins susceptible d'attirer une DPO. Le tableau juste au-dessus dit ce qui sort ;
 * cette carte en décide, et ne fait rien d'autre.
 */
function ReglageMasquage({ supporter, onSaved }: { supporter: boolean; onSaved: () => void }) {
  const t = useT();
  const cfg = useConfigDraft(
    toMaskDraft,
    toMaskPayload,
    tr(
      "Masquage enregistré. Il s'applique dès le prochain appel au modèle.",
      "Masking saved. It applies from the next model call.",
    ),
  );
  const { draft, patch } = cfg;

  // IBAN et secrets ne comptent comme masqués que si la licence Supporter les autorise :
  // cocher la case sans la licence ne masque rien, et le compteur ne doit pas le prétendre.
  const masques = [
    draft.email,
    draft.phone,
    supporter && draft.iban,
    supporter && draft.secret,
  ].filter(Boolean).length;

  async function enregistrer() {
    await cfg.save();
    onSaved();
  }

  return (
    <Card>
      <PanelHead
        title={
          <HeadTitle icon={<ShieldCheck />}>
            {t("Réglage du masquage", "Masking settings")}
          </HeadTitle>
        }
        subtitle={t(
          "Remplace les données sensibles par [EMAIL]/[IBAN]… AVANT l'envoi au LLM",
          "Replaces sensitive data with [EMAIL]/[IBAN]… BEFORE sending to the LLM",
        )}
        right={
          <Tag tone={masques === 4 ? "green" : masques === 0 ? "red" : "amber"}>{masques}/4</Tag>
        }
      />
      <CardContent className="flex flex-col gap-4">
        <Banner kind="error">
          {supporter
            ? t(
                "⚠ Désactiver un motif envoie cette donnée EN CLAIR au LLM — d'autant plus sensible si le fournisseur est hors UE (OpenAI, Anthropic). À valider avec la DPO.",
                "⚠ Disabling a pattern sends that data IN CLEAR to the LLM — especially sensitive with a non-EU provider (OpenAI, Anthropic). Validate with the DPO.",
              )
            : t(
                "⚠ Édition Community : les IBAN et les secrets (mots de passe, tokens, clés API) ne sont PAS masqués et sont envoyés EN CLAIR au LLM. Activez votre licence Supporter pour les masquer.",
                "⚠ Community edition: IBANs and secrets (passwords, tokens, API keys) are NOT masked and are sent IN CLEAR to the LLM. Activate your Supporter license to mask them.",
              )}
        </Banner>
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          <Toggle
            checked={draft.email}
            onChange={(v) => patch({ email: v })}
            label={t("Masquer les e-mails", "Mask emails")}
          />
          <Toggle
            checked={draft.phone}
            onChange={(v) => patch({ phone: v })}
            label={t("Masquer les téléphones", "Mask phone numbers")}
          />
          {supporter ? (
            <Toggle
              checked={draft.iban}
              onChange={(v) => patch({ iban: v })}
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
          {supporter ? (
            <Toggle
              checked={draft.secret}
              onChange={(v) => patch({ secret: v })}
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
        <div className="flex items-center justify-end gap-3">
          <p className="text-body text-muted-foreground">
            {cfg.dirty
              ? t("Modifications non enregistrées.", "Unsaved changes.")
              : t("Tout est enregistré.", "Everything is saved.")}
          </p>
          <Button onClick={enregistrer} disabled={!cfg.config || cfg.saving || !cfg.dirty}>
            {cfg.saving ? t("Enregistrement…", "Saving…") : t("Enregistrer", "Save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function Privacy() {
  const t = useT();
  const { lang } = useLang();
  const locale = useLocale();
  const toast = useToast();
  const privacy = useResource(useCallback(() => Api.privacy(), []));
  // La purge est réglée ailleurs (/automations) mais son ÉTAT conditionne la lecture des
  // durées affichées ici : « 30 j » avec la purge coupée ne veut rien dire.
  const retention = useResource(useCallback(() => Api.retention(), []));
  const [text, setText] = useState(() => tr(MASK_EXAMPLE_FR, MASK_EXAMPLE_EN));
  const [result, setResult] = useState<MaskTestOut | null>(null);
  // Le texte RÉELLEMENT testé, figé au moment du test : `text` continue de bouger sous les
  // doigts, il ne peut pas servir de référence pour dire « rien n'a été remplacé ».
  const [tested, setTested] = useState("");
  const [testing, setTesting] = useState(false);

  const view = privacy.data;
  const ret = retention.data;

  async function runTest() {
    setTesting(true);
    try {
      const out = await Api.testMask(text);
      setTested(text);
      setResult(out);
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  const label = (c: PiiCategory) => (lang === "fr" ? c.label_fr : c.label_en);

  // Catégories qui partent EN CLAIR : verrouillées Supporter, mais aussi celles que
  // l'admin a décochées (plus grave encore, et jusqu'ici invisible).
  const inClear = (v: PrivacyView) =>
    v.categories.filter((c) => !c.active && c.scope !== "roadmap");

  const hits = result ? Object.entries(result.counts).filter(([, n]) => n > 0) : [];
  // Garde-fou de dernier recours : un masquage sans compteur (marqueur d'un plugin hors
  // convention, par exemple) ne doit JAMAIS faire dire « ce texte part tel quel ». Le texte
  // affiché fait foi — on ne nie pas un remplacement qu'on montre à l'écran.
  const texteModifie = result !== null && result.masked !== tested;

  const lastRun = ret?.last_run_at
    ? new Date(ret.last_run_at).toLocaleString(locale, {
        dateStyle: "short",
        timeStyle: "short",
      })
    : t("jamais", "never");

  return (
    <div className="space-y-6">
      {/* ── En-tête : titre + édition ───────────────────────────────────── */}
      <Card>
        <PanelHead
          title={
            <HeadTitle icon={<ShieldCheck />}>
              {t("Confidentialité (DPO)", "Privacy (DPO)")}
            </HeadTitle>
          }
          subtitle={t(
            "Le masquage des données personnelles s'applique AVANT tout appel au LLM (souveraineté).",
            "Personal-data masking is applied BEFORE any LLM call (sovereignty).",
          )}
          right={
            view?.edition_advanced ? (
              <Tag tone="purple">
                <Lock className="h-3 w-3" />
                Supporter
              </Tag>
            ) : (
              <Tag tone="muted">Community</Tag>
            )
          }
        />
        <CardContent className="text-body text-muted-foreground">
          {t(
            "Avant d'envoyer un ticket au modèle, le moteur remplace les données sensibles (e-mail, téléphone…) par des marqueurs comme [EMAIL]. Cette page récapitule ce qui est masqué pour le RSSI / la DPO.",
            "Before sending a ticket to the model, the engine replaces sensitive data (email, phone…) with markers like [EMAIL]. This page summarises what is masked for the CISO / DPO.",
          )}
        </CardContent>
      </Card>

      {privacy.loading && (
        <p role="status" aria-live="polite" className="p-2 text-body text-muted-foreground">
          {t("Chargement…", "Loading…")}
        </p>
      )}
      {privacy.error && (
        <div className="flex flex-wrap items-center gap-3 p-2">
          <Banner kind="error" role="alert">
            {privacy.error}
          </Banner>
          {/* `useResource` sait recharger : sans ce bouton, la seule issue était F5. */}
          <Button size="sm" variant="outline" onClick={privacy.reload}>
            {t("Réessayer", "Retry")}
          </Button>
        </div>
      )}

      {view && (
        <>
          {/* ── Bandeau d'alerte Community ─────────────────────────────── */}
          {!view.edition_advanced && (
            <Banner kind="warning">
              {t(
                "⚠ Édition Community : les IBAN & cartes, les secrets (mots de passe, tokens, clés API), les IP/MAC et les NIR/SIRET ne sont PAS masqués. Ces données sont envoyées EN CLAIR au LLM et conservées en clair dans le journal. Activez votre licence Supporter pour les masquer.",
                "⚠ Community edition: IBANs & cards, secrets (passwords, tokens, API keys), IP/MAC and NIR/SIRET are NOT masked. This data is sent IN CLEAR to the LLM and stored in clear in the journal. Activate your Supporter license to mask it.",
              )}
            </Banner>
          )}

          {/* ── Catégories de données personnelles ─────────────────────── */}
          <Card>
            <PanelHead
              title={
                <HeadTitle icon={<ShieldCheck />}>
                  {t("Catégories de données", "Data categories")}
                </HeadTitle>
              }
              // « part tel quel » est RÉSERVÉ au verdict du testeur, qui l'affirme d'un
              // texte précis. L'employer aussi en sous-titre permanent le rendait
              // indiscernable d'une constatation — et un test ne pouvait plus vérifier que
              // la page ne le dit jamais à tort.
              subtitle={t(
                "Ce qui est remplacé avant l'envoi au modèle, et ce qui ne l'est pas.",
                "What is replaced before sending to the model, and what is not.",
              )}
            />
            <CardContent className="p-0">
              {/* Conteneur défilable : sans lui, la table pousse toute la page en
                  défilement horizontal sur mobile. */}
              <div className="overflow-x-auto">
                <table className="w-full text-body">
                  <thead>
                    <tr className="border-b border-border text-left text-caption font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      <th scope="col" className="px-5 py-2 font-semibold">
                        {t("Donnée", "Data")}
                      </th>
                      <th scope="col" className="px-5 py-2 font-semibold">
                        {t("Exemple", "Example")}
                      </th>
                      {/* La colonne répond à la question de la DPO (« qu'est-ce qui sort ? »),
                          pas à celle du commercial (« qu'est-ce qui est payant ? »). */}
                      <th scope="col" className="px-5 py-2 text-right font-semibold">
                        {t("Envoyé au LLM", "Sent to the LLM")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.categories.map((c) => (
                      <tr key={c.key} className="border-b border-border last:border-0">
                        <td className="px-5 py-2.5 font-medium">{label(c)}</td>
                        <td className="px-5 py-2.5">
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-caption text-muted-foreground">
                            {c.example}
                          </code>
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          {c.active ? (
                            <Tag tone="green">{t("Masqué", "Masked")}</Tag>
                          ) : c.scope === "roadmap" ? (
                            <Tag tone="muted">{t("Non implémenté", "Not implemented")}</Tag>
                          ) : (
                            <span className="inline-flex items-center justify-end gap-1.5">
                              <Tag tone="amber">{t("Envoyé en clair", "Sent in clear")}</Tag>
                              {/* Le verrou COMPLÈTE la conséquence, il ne la remplace pas. */}
                              {c.scope === "supporter" ? <LockedBadge /> : null}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── Réglage du masquage ────────────────────────────────────── */}
          {/* Ces quatre bascules vivaient sur la page « Moteur ». Cette page-ci EXPLIQUAIT
              donc un masquage qu'elle ne pouvait pas régler, et le seul écran capable de
              l'éteindre s'appelait « Moteur » — le dernier endroit où une DPO irait
              chercher. Le tableau ci-dessus dit ce qui sort ; la carte ci-dessous en décide. */}
          <ReglageMasquage
            supporter={view.edition_advanced}
            onSaved={() => {
              // Le tableau ci-dessus vient d'être démenti par l'enregistrement : le relire
              // est le minimum, sinon il affirme « Masqué » sur un motif qu'on vient de couper.
              privacy.reload();
            }}
          />

          {/* ── Outil de test de masquage ──────────────────────────────── */}
          <Card>
            <PanelHead
              title={
                <HeadTitle icon={<Eye />}>{t("Tester le masquage", "Test masking")}</HeadTitle>
              }
              subtitle={t(
                "Collez un texte : visualisez ce qui partira réellement au LLM.",
                "Paste some text: preview what will actually be sent to the LLM.",
              )}
            />
            <CardContent className="flex flex-col gap-3">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-24 font-mono text-body"
                placeholder={t("Texte à tester…", "Text to test…")}
              />
              <div>
                <Button onClick={runTest} disabled={testing || !text.trim()}>
                  {testing ? t("Test…", "Testing…") : t("Tester", "Test")}
                </Button>
              </div>
              {result !== null && (
                <div className="flex flex-col gap-2">
                  <span className="text-caption font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {t("Envoyé au LLM", "Sent to the LLM")}
                  </span>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-body">
                    {result.masked}
                  </pre>
                  {/* Les compteurs disent ce qui a été remplacé — sans eux, il fallait
                      comparer les deux blocs à l'œil pour voir ce qui a survécu. */}
                  {hits.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-caption text-muted-foreground">
                        {t("Remplacements :", "Replacements:")}
                      </span>
                      {hits.map(([k, n]) => (
                        <Tag key={k} tone="green">
                          {COUNT_LABELS[k] ? t(COUNT_LABELS[k][0], COUNT_LABELS[k][1]) : k} × {n}
                        </Tag>
                      ))}
                    </div>
                  ) : texteModifie ? (
                    <p className="text-caption text-muted-foreground">
                      {t(
                        "Des données ont été remplacées (voir le texte ci-dessus) : elles ne partent pas au LLM.",
                        "Some data was replaced (see the text above): it does not reach the LLM.",
                      )}
                    </p>
                  ) : (
                    <p className="text-caption text-muted-foreground">
                      {t(
                        "Aucun remplacement — ce texte part tel quel au LLM.",
                        "No replacement — this text leaves untouched to the LLM.",
                      )}
                    </p>
                  )}
                  {inClear(view).length > 0 ? (
                    <Banner kind="warning">
                      {t(
                        `⚠ Non masqué dans l'état actuel, donc envoyé en clair : ${inClear(view)
                          .map((c) => c.label_fr)
                          .join(", ")}.`,
                        `⚠ Not masked in the current state, therefore sent in clear: ${inClear(view)
                          .map((c) => c.label_en)
                          .join(", ")}.`,
                      )}
                    </Banner>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Panneau latéral : journal · rétention · export ─────────── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Journal llm_calls */}
            <Card>
              <PanelHead
                title={
                  <HeadTitle icon={<ScrollText />}>
                    {t("Journal llm_calls", "llm_calls journal")}
                  </HeadTitle>
                }
              />
              <CardContent className="flex flex-col gap-3 text-body">
                <div>
                  <span className="text-metric font-semibold">{view.llm_calls_count}</span>
                  <span className="ml-2 text-muted-foreground">
                    {t("appels enregistrés", "recorded calls")}
                  </span>
                </div>
                {/* Link stylé en bouton (pas de <button> dans <a> : HTML invalide). */}
                <Link to="/journal" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  {t("Voir le journal llm_calls", "View llm_calls journal")}
                </Link>
              </CardContent>
            </Card>

            {/* Rétention — durées ET état réel de la purge */}
            <Card>
              <PanelHead
                title={<HeadTitle icon={<Clock />}>{t("Rétention", "Retention")}</HeadTitle>}
                right={
                  ret ? (
                    ret.enabled ? (
                      <Tag tone="green">{t("Purge active", "Purge on")}</Tag>
                    ) : (
                      <Tag tone="amber">{t("Purge désactivée", "Purge off")}</Tag>
                    )
                  ) : null
                }
              />
              <CardContent className="flex flex-col gap-2 text-body">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("Décisions", "Decisions")}</span>
                  <span className="font-medium">
                    {ret?.decisions_days ?? view.retention_decisions_days} {t("j", "d")}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("Appels LLM", "LLM calls")}</span>
                  <span className="font-medium">
                    {ret?.llm_calls_days ?? view.retention_llm_calls_days} {t("j", "d")}
                  </span>
                </div>
                {retention.loading && (
                  <p
                    role="status"
                    aria-live="polite"
                    className="text-caption text-muted-foreground"
                  >
                    {t("Chargement de l'état de la purge…", "Loading purge state…")}
                  </p>
                )}
                {retention.error && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Banner kind="error" role="alert">
                      {t(
                        "État de la purge indisponible : ces durées ne prouvent RIEN.",
                        "Purge state unavailable: these durations prove NOTHING.",
                      )}
                    </Banner>
                    <Button size="sm" variant="outline" onClick={retention.reload}>
                      {t("Réessayer", "Retry")}
                    </Button>
                  </div>
                )}
                {/* Le seul mensonge structurel possible ici : afficher « 30 j » alors que
                    rien n'est jamais supprimé. On le dit, et fort. */}
                {ret && !ret.enabled && (
                  <Banner kind="warning">
                    {t(
                      "⚠ Purge automatique DÉSACTIVÉE — aucune donnée n'est supprimée, quelles que soient les durées ci-dessus.",
                      "⚠ Automatic purge DISABLED — no data is deleted, whatever the durations above.",
                    )}
                  </Banner>
                )}
                {ret?.enabled && (
                  <p className="text-caption text-muted-foreground">
                    {t(
                      `Passage quotidien à ${ret.hour_utc} h UTC · dernière exécution : ${lastRun}.`,
                      `Runs daily at ${ret.hour_utc}:00 UTC · last run: ${lastRun}.`,
                    )}
                  </p>
                )}
                {/* Réglage (et purge manuelle) : sur leur page. Aucune action destructive ici. */}
                <Link
                  to="/automations"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {t("Régler la purge", "Configure purge")}
                </Link>
              </CardContent>
            </Card>

            {/* Export rapport DPO */}
            <Card>
              <PanelHead
                title={
                  <HeadTitle icon={<FileDown />}>
                    {t("Export rapport DPO", "Export DPO report")}
                  </HeadTitle>
                }
              />
              <CardContent className="flex flex-col gap-3 text-body">
                <p className="text-muted-foreground">
                  {t(
                    "Rapport Markdown récapitulant le masquage et la rétention.",
                    "Markdown report summarising masking and retention.",
                  )}
                </p>
                {DEMO ? (
                  <span title={t("Indisponible en mode démo", "Unavailable in demo mode")}>
                    <Button variant="outline" size="sm" disabled>
                      <FileDown className="h-4 w-4" />
                      {t("Télécharger (.md)", "Download (.md)")}
                    </Button>
                  </span>
                ) : (
                  // Ancre stylée en bouton (pas de <button> dans <a> : HTML invalide).
                  <a
                    href={DPO_REPORT_URL}
                    download
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <FileDown className="h-4 w-4" />
                    {t("Télécharger (.md)", "Download (.md)")}
                  </a>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
