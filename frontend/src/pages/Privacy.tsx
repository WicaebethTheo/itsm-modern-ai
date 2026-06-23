import { Banner } from "@/components/Banner";
import { LockedBadge } from "@/components/ui/LockedBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api, DEMO, DPO_REPORT_URL, type PiiCategory } from "@/lib/api";
import { useLang, useT } from "@/lib/i18n";
import { Clock, Eye, FileDown, Lock, ScrollText, ShieldCheck } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Link } from "react-router-dom";

const MASK_EXAMPLE =
  "Bonjour, je n'arrive plus à me connecter. Mon e-mail est jean.dupont@example.com " +
  "et le virement vers l'IBAN FR76 3000 4000 5000 0123 4567 890 est bloqué. Merci.";

/** En-tête de carte avec une icône à gauche du titre. */
function HeadTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      {children}
    </span>
  );
}

export function Privacy() {
  const t = useT();
  const { lang } = useLang();
  const toast = useToast();
  const privacy = useResource(useCallback(() => Api.privacy(), []));
  const [text, setText] = useState(MASK_EXAMPLE);
  const [masked, setMasked] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const view = privacy.data;

  async function runTest() {
    setTesting(true);
    try {
      const out = await Api.testMask(text);
      setMasked(out.masked);
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  const label = (c: PiiCategory) => (lang === "fr" ? c.label_fr : c.label_en);

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
        <CardContent className="p-5 text-[12.5px] text-muted-foreground">
          {t(
            "Avant d'envoyer un ticket au modèle, le moteur remplace les données sensibles (e-mail, téléphone…) par des marqueurs comme [EMAIL]. Cette page récapitule ce qui est masqué pour le RSSI / la DPO.",
            "Before sending a ticket to the model, the engine replaces sensitive data (email, phone…) with markers like [EMAIL]. This page summarises what is masked for the CISO / DPO.",
          )}
        </CardContent>
      </Card>

      {privacy.loading && (
        <p className="p-2 text-[12.5px] text-muted-foreground">{t("Chargement…", "Loading…")}</p>
      )}
      {privacy.error && <p className="p-2 text-[12.5px] text-destructive">{privacy.error}</p>}

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
                  {t("Catégories masquées", "Masked categories")}
                </HeadTitle>
              }
              subtitle={t(
                "Motifs détectés et remplacés avant l'envoi au modèle.",
                "Patterns detected and replaced before sending to the model.",
              )}
            />
            <CardContent className="p-0">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2 font-semibold">{t("Donnée", "Data")}</th>
                    <th className="px-4 py-2 font-semibold">{t("Exemple", "Example")}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t("Statut", "Status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.categories.map((c) => (
                    <tr key={c.key} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium">{label(c)}</td>
                      <td className="px-4 py-2.5">
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-muted-foreground">
                          {c.example}
                        </code>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {c.active ? (
                          <Tag tone="green">
                            {t("Actif", "Active")}
                            {c.scope === "community" ? " (Community)" : ""}
                          </Tag>
                        ) : c.scope === "roadmap" ? (
                          <Tag tone="muted">{t("À venir", "Coming")}</Tag>
                        ) : c.scope === "supporter" ? (
                          <span
                            className="inline-flex items-center gap-1"
                            title={t("Verrouillé · Supporter", "Locked · Supporter")}
                          >
                            <span className="text-[11px] text-muted-foreground">
                              {t("Verrouillé ·", "Locked ·")}
                            </span>
                            <LockedBadge />
                          </span>
                        ) : (
                          <Tag tone="muted">{t("Inactif", "Inactive")}</Tag>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

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
            <CardContent className="flex flex-col gap-3 p-5">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-24 font-mono text-[12px]"
                placeholder={t("Texte à tester…", "Text to test…")}
              />
              <div>
                <Button onClick={runTest} disabled={testing || !text.trim()}>
                  {testing ? t("Test…", "Testing…") : t("Tester", "Test")}
                </Button>
              </div>
              {masked !== null && (
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("Envoyé au LLM", "Sent to the LLM")}
                  </span>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-[12px]">
                    {masked}
                  </pre>
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
              <CardContent className="flex flex-col gap-3 p-5 text-[12.5px]">
                <div>
                  <span className="text-2xl font-semibold">{view.llm_calls_count}</span>
                  <span className="ml-2 text-muted-foreground">
                    {t("appels enregistrés", "recorded calls")}
                  </span>
                </div>
                <Link to="/journal">
                  <Button variant="outline" size="sm">
                    {t("Voir le journal llm_calls", "View llm_calls journal")}
                  </Button>
                </Link>
              </CardContent>
            </Card>

            {/* Rétention par défaut */}
            <Card>
              <PanelHead
                title={
                  <HeadTitle icon={<Clock />}>
                    {t("Rétention par défaut", "Default retention")}
                  </HeadTitle>
                }
              />
              <CardContent className="flex flex-col gap-2 p-5 text-[12.5px]">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("Décisions", "Decisions")}</span>
                  <span className="font-medium">
                    {view.retention_decisions_days} {t("j", "d")}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("Appels LLM", "LLM calls")}</span>
                  <span className="font-medium">
                    {view.retention_llm_calls_days} {t("j", "d")}
                  </span>
                </div>
                <p className="mt-1 text-[11.5px] text-muted-foreground/80">
                  {t(
                    "La purge est exécutée par la tâche RGPD planifiée.",
                    "Purge runs via the scheduled RGPD job.",
                  )}
                </p>
                <p className="text-[11.5px] text-muted-foreground/80">
                  {t(
                    "Étendu avec « DPO+ exports » (à venir).",
                    "Extended with DPO+ exports (coming).",
                  )}
                </p>
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
              <CardContent className="flex flex-col gap-3 p-5 text-[12.5px]">
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
                  <a href={DPO_REPORT_URL} download>
                    <Button variant="outline" size="sm">
                      <FileDown className="h-4 w-4" />
                      {t("Télécharger (.md)", "Download (.md)")}
                    </Button>
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
