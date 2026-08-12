import { FlaskConical } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Banner } from "@/components/Banner";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useResource } from "@/hooks/useResource";
import { Api, type SandboxResult } from "@/lib/api";
import { useT } from "@/lib/i18n";
import {
  confidenceTone,
  priorityLabel,
  priorityTone,
  type ReasonStage,
  reasonLabel,
  reasonStage,
  reasonTone,
} from "@/lib/labels";

/**
 * Nom de l'étage du pipeline où le refus a eu lieu. Sans lui, l'écran désignait le
 * mauvais garde-fou : « Validation liste blanche » pour un `low_confidence` envoie
 * l'admin corriger le périmètre alors que c'est le SEUIL qu'il faut ajuster.
 */
const STAGE: Record<ReasonStage, { fr: string; en: string }> = {
  ok: { fr: "garde-fous", en: "guardrails" },
  llm: { fr: "appel au LLM", en: "LLM call" },
  whitelist: { fr: "liste blanche (périmètre)", en: "whitelist (scope)" },
  threshold: { fr: "seuil de confiance", en: "confidence threshold" },
  cap: { fr: "plafond de coût", en: "cost cap" },
};

/** Tickets d'exemple : la page est vide au premier accès, on doit pouvoir démarrer sans rien taper. */
const EXAMPLES: { titleFr: string; titleEn: string; bodyFr: string; bodyEn: string }[] = [
  {
    titleFr: "Mot de passe refusé",
    titleEn: "Password rejected",
    bodyFr:
      "slt jarrive plus a me connecter depuis ce matin, mdp refusé a chaque fois. " +
      "Mon mail c'est jean.dupont@example.com, merci de rappeler au 06 12 34 56 78.",
    bodyEn:
      "hi I can't log in anymore since this morning, password rejected every time. " +
      "My email is jean.dupont@example.com, please call me back on 06 12 34 56 78.",
  },
  {
    titleFr: "Imprimante étage 2 hors service",
    titleEn: "2nd floor printer down",
    bodyFr:
      "L'imprimante du couloir (10.0.1.42) affiche « bourrage papier » alors qu'il n'y a " +
      "aucune feuille coincée. Toute l'équipe compta est bloquée pour la clôture.",
    bodyEn:
      "The hallway printer (10.0.1.42) shows “paper jam” although no sheet is stuck. " +
      "The whole accounting team is blocked for the monthly close.",
  },
  {
    titleFr: "Demande d'accès à un dossier partagé",
    titleEn: "Shared folder access request",
    bodyFr:
      "Bonjour, pourriez-vous m'ouvrir l'accès au dossier RH sur le serveur de fichiers ? " +
      "C'est pour la campagne d'entretiens annuels. Pas urgent.",
    bodyEn:
      "Hello, could you grant me access to the HR folder on the file server? " +
      "It is for the annual review campaign. Not urgent.",
  },
];

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-[12.5px]" : "text-[12.5px] font-medium"}>
        {value}
      </span>
    </div>
  );
}

/** Squelette d'attente : 2 à 10 s d'appel LLM ne doivent pas se lire comme un échec. */
function ResultSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-1">
      <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-1">
          <span className="h-2.5 w-32 animate-pulse rounded bg-muted" />
          <span className="h-2.5 w-24 animate-pulse rounded bg-muted" />
        </div>
      ))}
      <div className="h-16 w-full animate-pulse rounded-md bg-muted" />
    </div>
  );
}

export function Sandbox() {
  const t = useT();
  // Le seuil vit dans la config runtime : « 62 % » ne veut rien dire sans lui.
  const config = useResource(useCallback(() => Api.getConfig(), []));
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [masked, setMasked] = useState<string | null>(null);
  const [maskError, setMaskError] = useState("");
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const rawThreshold = config.data?.confidence_threshold;
  const threshold = rawThreshold != null && rawThreshold !== "" ? Number(rawThreshold) : null;
  const thresholdPct =
    threshold != null && Number.isFinite(threshold) ? Math.round(threshold * 100) : null;

  function fill(e: (typeof EXAMPLES)[number]) {
    setTitle(t(e.titleFr, e.titleEn));
    setText(t(e.bodyFr, e.bodyEn));
  }

  async function run() {
    setError("");
    setResult(null);
    setMasked(null);
    setMaskError("");
    setElapsedMs(null);
    setBusy(true);
    const started = performance.now();
    try {
      const r = await Api.sandbox(text, title);
      setElapsedMs(performance.now() - started);
      setResult(r);
      // Ce qui est RÉELLEMENT parti chez le fournisseur : même masqueur, même gating
      // de licence que le moteur. On n'affiche QUE la sortie du masqueur — jamais le
      // brut re-rendu, sinon l'écran censé prouver le masquage exposerait la PII.
      try {
        setMasked((await Api.testMask(`${title}\n${text}`.trim())).masked);
      } catch (e: unknown) {
        setMaskError((e as Error).message);
      }
    } catch (e: unknown) {
      // ApiError porte déjà le message backend (detail.message) ou un libellé par status.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const stage = result ? reasonStage(result.reason) : null;
  const stageName = stage ? t(STAGE[stage].fr, STAGE[stage].en) : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Ticket de test */}
      <Card>
        <PanelHead
          title={t("Ticket de test", "Test ticket")}
          subtitle={t(
            "Le texte n'est jamais déposé dans GLPI",
            "The text is never written to GLPI",
          )}
        />
        <CardContent className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sandbox-title">{t("Titre du ticket", "Ticket title")}</Label>
            <Input
              id="sandbox-title"
              value={title}
              placeholder={t("Ex. « Mot de passe refusé »", "E.g. “Password rejected”")}
              onChange={(e) => setTitle(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t(
                "Le moteur réel analyse le titre ET le contenu : un essai sans titre n'est pas représentatif.",
                "The real engine reads the title AND the content: a title-less run is not representative.",
              )}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sandbox-content">{t("Contenu du ticket", "Ticket content")}</Label>
            <Textarea
              id="sandbox-content"
              rows={8}
              value={text}
              placeholder={t(
                "Collez le texte d'un ticket (ex. « slt jarrive plus à me connecter, mdp refusé »)…",
                "Paste a ticket's text (e.g. “hi I can't log in anymore, password rejected”)…",
              )}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {t("Exemples :", "Examples:")}
            </span>
            {EXAMPLES.map((e) => (
              <Button
                key={e.titleEn}
                size="sm"
                variant="outline"
                type="button"
                onClick={() => fill(e)}
              >
                {t(e.titleFr, e.titleEn)}
              </Button>
            ))}
          </div>
          <div>
            <Button onClick={run} disabled={busy || !text.trim()}>
              {busy ? t("Analyse…", "Analyzing…") : t("Simuler la décision", "Simulate decision")}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Décision simulée */}
      <Card>
        <PanelHead
          title={t("Décision simulée", "Simulated decision")}
          right={
            result ? (
              result.accepted ? (
                <Tag tone="green">{t("passe les garde-fous", "passes the guardrails")}</Tag>
              ) : (
                <Tag tone="amber">{t("à trier", "to triage")}</Tag>
              )
            ) : undefined
          }
        />
        <CardContent className="p-5">
          <div aria-live="polite" aria-busy={busy}>
            {busy ? (
              <ResultSkeleton />
            ) : result ? (
              <>
                {/* Verdict AVANT le détail : sans lui, un routage refusé se lit exactement
                    comme un routage qui aura lieu — et l'admin croit à une écriture GLPI. */}
                <Banner kind={result.accepted ? "success" : "warning"}>
                  <strong className="font-semibold">
                    {result.accepted
                      ? t(
                          "Le moteur laisserait passer cette décision.",
                          "The engine would let this decision through.",
                        )
                      : t(
                          "Le moteur BLOQUE cette décision — le ticket partirait « à trier ».",
                          "The engine BLOCKS this decision — the ticket would go to “to triage”.",
                        )}
                  </strong>{" "}
                  <span className="text-foreground/80">
                    {t(
                      "Ce qui suit est la proposition du LLM, conservée pour explication. Rien ne serait écrit dans GLPI.",
                      "What follows is the LLM's proposal, kept for explanation. Nothing would be written to GLPI.",
                    )}
                  </span>
                </Banner>
                <div className="mt-4 flex flex-col">
                  <Row
                    label={t("Routage — catégorie", "Routing — category")}
                    value={
                      result.category_name
                        ? `${result.category_name} (#${result.category})`
                        : (result.category ?? "—")
                    }
                  />
                  <Row
                    label={t("Priorité", "Priority")}
                    value={
                      result.priority != null ? (
                        <Tag tone={priorityTone(result.priority)}>
                          {priorityLabel(result.priority, t)}
                        </Tag>
                      ) : (
                        "—"
                      )
                    }
                  />
                  <Row
                    label={t("Routage — technicien / groupe", "Routing — technician / group")}
                    value={
                      result.technician_id != null
                        ? result.technician_name
                          ? `${result.technician_name} (#${result.technician_id})`
                          : `T#${result.technician_id}`
                        : result.group_id != null
                          ? result.group_name
                            ? `${result.group_name} (#${result.group_id})`
                            : `G#${result.group_id}`
                          : "—"
                    }
                  />
                  <Row
                    label={t("Confiance", "Confidence")}
                    value={
                      <span className="flex items-center gap-2">
                        {result.confidence != null ? (
                          <Tag tone={confidenceTone(result.confidence)}>
                            {Math.round(result.confidence * 100)}%
                          </Tag>
                        ) : (
                          "—"
                        )}
                        {thresholdPct != null && (
                          <span className="text-[11px] font-normal text-muted-foreground">
                            {t(`seuil ${thresholdPct} %`, `threshold ${thresholdPct}%`)}
                          </span>
                        )}
                      </span>
                    }
                  />
                  <Row
                    label={
                      result.accepted
                        ? t("Verdict des garde-fous", "Guardrails verdict")
                        : stageName
                          ? t(`Refus à l'étape : ${stageName}`, `Blocked at stage: ${stageName}`)
                          : t("Motif du refus", "Rejection reason")
                    }
                    value={
                      <Tag tone={reasonTone(result.reason)}>{reasonLabel(result.reason, t)}</Tag>
                    }
                  />
                </div>
                {result.draft && (
                  <div className="mt-4">
                    <p className="mb-1.5 text-[11px] text-muted-foreground">
                      {t("Brouillon de réponse (draft)", "Draft reply (draft)")}
                    </p>
                    <p className="whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-[12.5px] leading-relaxed">
                      {result.draft}
                    </p>
                  </div>
                )}

                {/* Souveraineté : ce qui est SORTI de l'instance, mot pour mot. */}
                <details className="mt-4 rounded-md border border-border">
                  <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium">
                    {t(
                      "Texte réellement envoyé au LLM (masqué)",
                      "Text actually sent to the LLM (masked)",
                    )}
                  </summary>
                  <div className="border-t border-border px-3 py-2">
                    {masked !== null ? (
                      <p className="whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-[12px] leading-relaxed">
                        {masked}
                      </p>
                    ) : (
                      <p className="text-[12px] text-muted-foreground">
                        {maskError || t("Masquage indisponible.", "Masking preview unavailable.")}
                      </p>
                    )}
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {t(
                        "En édition Community, seuls l'e-mail et le téléphone sont masqués : IBAN, adresses IP et secrets partent EN CLAIR — c'est ce que montre le bloc ci-dessus.",
                        "In the Community edition only email and phone are masked: IBAN, IP addresses and secrets leave IN CLEAR — that is exactly what the block above shows.",
                      )}
                    </p>
                  </div>
                </details>

                {/* Ce que l'essai a coûté : la sandbox est comptée dans le plafond. */}
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-[11px] text-muted-foreground">
                  {result.model && (
                    <span>
                      {t("Modèle", "Model")} : <span className="font-mono">{result.model}</span>
                    </span>
                  )}
                  {result.cost_eur != null && (
                    <span>
                      {t("Coût de l'essai", "Run cost")} : {result.cost_eur.toFixed(4)} €
                    </span>
                  )}
                  {(result.prompt_tokens != null || result.completion_tokens != null) && (
                    <span>
                      {t("Jetons", "Tokens")} : {result.prompt_tokens ?? 0} →{" "}
                      {result.completion_tokens ?? 0}
                    </span>
                  )}
                  {elapsedMs != null && (
                    <span>
                      {t("Latence", "Latency")} : {(elapsedMs / 1000).toFixed(1)} s
                    </span>
                  )}
                </div>
              </>
            ) : (
              <EmptyState
                icon={FlaskConical}
                title={t("Aucune simulation", "No simulation")}
                description={t(
                  "Saisissez un ticket à gauche (ou choisissez un exemple) puis lancez la simulation.",
                  "Enter a ticket on the left (or pick an example), then run the simulation.",
                )}
              />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
