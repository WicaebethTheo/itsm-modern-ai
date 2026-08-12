import { Check } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LockedBadge } from "@/components/ui/LockedBadge";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api, updateCommand } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Erreurs de licence renvoyées par le backend (`domain/licensing.verify_license`) →
 * message bilingue ET ACTIONNABLE. Sans cette table, l'UI affichait la chaîne française
 * brute même en anglais, et devait renifler `includes("expir")` pour deviner le cas
 * « expirée » — un reniflage que la moindre reformulation backend cassait.
 * Clé inconnue ⇒ repli sur le message brut (jamais d'écran muet).
 */
const LICENSE_ERRORS: Record<string, { fr: string; en: string; expiry?: boolean }> = {
  "format de jeton invalide": {
    fr: "Format de jeton invalide. Recollez la clé ENTIÈRE, d'un seul bloc (elle commence par « itsm-lic.v1. »), sans espace ni retour à la ligne ajouté.",
    en: 'Invalid token format. Paste the WHOLE key in one block (it starts with "itsm-lic.v1."), with no added space or line break.',
  },
  "signature invalide": {
    fr: "Signature invalide : cette clé n'a pas été émise par l'éditeur, ou son contenu a été modifié. Recollez-la telle qu'elle vous a été fournie ; si le refus persiste, demandez une clé ré-émise.",
    en: "Invalid signature: this key was not issued by the publisher, or its content was altered. Paste it exactly as delivered; if it keeps failing, request a re-issued key.",
  },
  "jeton illisible": {
    fr: "Jeton illisible (partie signature). La copie est probablement tronquée : recollez la clé entière, ou demandez une clé ré-émise.",
    en: "Unreadable token (signature part). The copy is likely truncated: paste the whole key again, or request a re-issued key.",
  },
  "charge utile illisible": {
    fr: "Contenu du jeton illisible. La clé est corrompue ou incomplète : demandez une clé ré-émise.",
    en: "Unreadable token payload. The key is corrupted or incomplete: request a re-issued key.",
  },
  "licence expirée": {
    fr: "Licence expirée. Les fonctionnalités Supporter restent verrouillées : demandez une clé renouvelée et collez-la ci-dessous.",
    en: "Expired license. Supporter features stay locked: request a renewed key and paste it below.",
    expiry: true,
  },
  "jeton trop volumineux": {
    fr: "Jeton trop volumineux — ce n'est probablement pas une clé de licence. Collez uniquement la ligne « itsm-lic.v1.… ».",
    en: 'Token too large — this is probably not a license key. Paste only the "itsm-lic.v1.…" line.',
  },
};

export function Store() {
  const t = useT();
  const toast = useToast();
  const keyFieldId = useId();
  const license = useResource(useCallback(() => Api.getLicense(), []));
  const version = useResource(useCallback(() => Api.version(), []));
  const ver = version.data;
  // Commande de MAJ adaptée au runtime (Docker vs hôte) — même logique que la topbar.
  const updateCmd = updateCommand(ver?.runtime);
  const [key, setKey] = useState("");
  const [activating, setActivating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showRenew, setShowRenew] = useState(false);

  async function copyUpdateCmd() {
    try {
      await navigator.clipboard.writeText(updateCmd);
      toast.success(t("Commande copiée.", "Command copied."));
    } catch {
      toast.error(t("Copie impossible — copiez manuellement.", "Copy failed — copy manually."));
    }
  }

  const lic = license.data;
  const features = lic?.features ?? [];
  // Badge honnête : "Supporter" uniquement si une feature est RÉELLEMENT active
  // (installée ET licenciée), pas seulement parce qu'une clé est présente.
  const anyActive = features.some((f) => f.active);
  // Une licence valide peut exister SANS couvrir un module donné : on distingue les
  // deux, sinon le catalogue accuse à tort le client de ne pas avoir de licence.
  const licensed = !!lic?.valid && lic.edition === "supporter";
  const activeCount = features.filter((f) => f.active).length;
  const installedCount = features.filter((f) => f.installed).length;
  const invalidError = lic && !lic.valid ? lic.error : null;
  const mappedError = invalidError ? LICENSE_ERRORS[invalidError] : undefined;
  const errorText = mappedError ? t(mappedError.fr, mappedError.en) : invalidError;
  // Expiration : jours restants (depuis expires_at), pour prévenir avant l'échéance.
  const daysLeft = (() => {
    if (!lic?.expires_at) return null;
    const ms = new Date(`${lic.expires_at}T00:00:00Z`).getTime() - Date.now();
    return Math.ceil(ms / 86_400_000);
  })();
  const expiringSoon = anyActive && daysLeft != null && daysLeft <= 30;

  async function activate() {
    if (!key.trim()) return;
    setActivating(true);
    try {
      const view = await Api.setLicense(key.trim());
      license.reload();
      if (view.valid) {
        setKey("");
        toast.success(t("Licence activée.", "License activated."));
      } else {
        toast.error(
          `${t("Clé refusée", "Key rejected")} : ${view.error ?? t("clé invalide", "invalid key")}`,
        );
      }
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    } finally {
      setActivating(false);
    }
  }

  async function reset() {
    if (
      !window.confirm(
        t(
          "Réinitialiser la licence et revenir à l'édition Community ?",
          "Reset the license and go back to the Community edition?",
        ),
      )
    )
      return;
    setResetting(true);
    try {
      await Api.deleteLicense();
      setKey("");
      license.reload();
      toast.success(t("Licence réinitialisée.", "License reset."));
    } catch (e: unknown) {
      toast.error(`${t("Erreur", "Error")} : ${(e as Error).message}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Bandeau d'édition : badge + résumé chiffré de ce qui est RÉELLEMENT actif. */}
      <Card>
        <PanelHead
          title={t("Édition", "Edition")}
          subtitle={t(
            "Open-core : les fonctionnalités Supporter se débloquent avec une clé — hors-ligne, aucune donnée ne sort.",
            "Open-core: Supporter features unlock with a key — offline, no data leaves.",
          )}
          right={
            anyActive ? (
              <Tag tone="purple">
                <Check className="h-3 w-3" />
                Supporter
              </Tag>
            ) : (
              <Tag tone="muted">Community</Tag>
            )
          }
        />
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body">
          {/* « Qu'est-ce qui est actif chez moi ? » — répondu ici, en une ligne, sans
              faire descendre l'exploitant de deux cartes. */}
          {anyActive ? (
            <>
              <Tag tone="green">
                {t(
                  `${activeCount} module(s) actif(s) sur ${features.length}`,
                  `${activeCount} of ${features.length} module(s) active`,
                )}
              </Tag>
              <Tag tone="muted">
                {lic?.expires_at
                  ? t(`Jusqu'au ${lic.expires_at}`, `Until ${lic.expires_at}`)
                  : t("Sans expiration", "No expiry")}
              </Tag>
              {/* Le titulaire reste sur la carte « Licence active » : le répéter ici ne
                  répondrait pas à « qu'est-ce qui est actif ? ». */}
            </>
          ) : (
            <>
              <Tag tone="muted">
                {t(
                  `${installedCount} module(s) Supporter installés mais verrouillés`,
                  `${installedCount} Supporter module(s) installed but locked`,
                )}
              </Tag>
              <span className="text-muted-foreground">
                {t(
                  "Édition Community — le moteur de triage fonctionne entièrement.",
                  "Community edition — the triage engine works in full.",
                )}
              </span>
            </>
          )}
        </CardContent>
      </Card>

      {/* Mise à jour disponible : notes + commande à lancer sur l'hôte (zéro action
          privilégiée dans l'app — l'admin copie/colle la commande). */}
      {ver?.update_available ? (
        <Card>
          <PanelHead
            title={t(`Mise à jour disponible : v${ver.latest}`, `Update available: v${ver.latest}`)}
            subtitle={t(
              "À lancer sur l'hôte du déploiement — la configuration et les données sont conservées.",
              "Run on the deployment host — configuration and data are preserved.",
            )}
            right={<Tag tone="indigo">↑ v{ver.latest}</Tag>}
          />
          <CardContent className="flex flex-col gap-3">
            {ver.latest_notes ? (
              <div className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-body leading-relaxed text-muted-foreground">
                {ver.latest_notes}
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <pre className="flex-1 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-body">
                {updateCmd}
              </pre>
              <Button variant="outline" onClick={copyUpdateCmd}>
                {t("Copier", "Copy")}
              </Button>
            </div>
            <a
              href="https://docs.itsm-modern-ai.com/update/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-body text-accent-indigo hover:underline"
            >
              {t("Voir toutes les notes de version", "View all release notes")}
            </a>
          </CardContent>
        </Card>
      ) : null}

      {/* DEUX états seulement : licence active, ou pas. Le code Supporter est TOUJOURS
          présent (édition unique), une troisième carte « code absent » ne pouvait donc
          jamais s'afficher chez un exploitant — et emportait avec elle la seule mention
          de la vérification hors-ligne. */}
      {anyActive ? (
        /* Licence ACTIVE : statut + renouvellement (remplacer par une nouvelle clé). */
        <Card>
          <PanelHead
            title={t("Licence active", "Active license")}
            subtitle={t(
              "Licence Supporter valide, vérifiée hors-ligne (Ed25519, aucun appel sortant). Renouvelez-la avec une nouvelle clé avant l'expiration.",
              "Valid Supporter license, verified offline (Ed25519, no outbound call). Renew it with a new key before it expires.",
            )}
            right={
              <Tag tone="green">
                <Check className="h-3 w-3" />
                {t("Active", "Active")}
              </Tag>
            }
          />
          <CardContent className="flex flex-col gap-3 text-body">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {lic?.customer ? (
                <span>
                  <span className="text-muted-foreground">{t("Client", "Customer")} : </span>
                  <span className="font-medium">{lic.customer}</span>
                </span>
              ) : null}
              {lic?.expires_at ? (
                <span>
                  <span className="text-muted-foreground">{t("Expire le", "Expires on")} : </span>
                  <span className="font-medium">
                    {lic.expires_at}
                    {daysLeft != null ? ` (${daysLeft} ${t("j", "d")})` : ""}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {t("Licence perpétuelle (sans expiration).", "Perpetual license (no expiry).")}
                </span>
              )}
            </div>
            {expiringSoon ? (
              <Banner kind="warning">
                {t(
                  `⚠ Votre licence expire dans ${daysLeft} jour(s). Demandez une clé renouvelée et collez-la ci-dessous pour la prolonger.`,
                  `⚠ Your license expires in ${daysLeft} day(s). Request a renewed key and paste it below to extend it.`,
                )}
              </Banner>
            ) : null}
            {showRenew ? (
              <>
                <label htmlFor={keyFieldId} className="text-body font-medium">
                  {t("Nouvelle clé de licence", "New license key")}
                </label>
                <Textarea
                  id={keyFieldId}
                  value={key}
                  placeholder={t("Coller la nouvelle clé…", "Paste the new key…")}
                  className="min-h-24 font-mono text-body"
                  onChange={(e) => setKey(e.target.value)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={activate} disabled={activating || !key.trim()}>
                    {activating
                      ? t("Application…", "Applying…")
                      : t("Appliquer la nouvelle clé", "Apply new key")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowRenew(false);
                      setKey("");
                    }}
                  >
                    {t("Annuler", "Cancel")}
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => setShowRenew(true)}>
                  {t("Renouveler / remplacer la clé", "Renew / replace key")}
                </Button>
                <Button variant="outline" onClick={reset} disabled={resetting}>
                  {resetting ? t("Réinitialisation…", "Resetting…") : t("Réinitialiser", "Reset")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        /* Aucune licence active (absente, refusée ou EXPIRÉE) : saisie de la clé. */
        <Card>
          <PanelHead
            title={t("Activer une licence", "Activate a license")}
            subtitle={t(
              "Collez le jeton fourni à la livraison (ou une clé renouvelée si la précédente a expiré).",
              "Paste the token provided with your license (or a renewed key if the previous one expired).",
            )}
          />
          <CardContent className="flex flex-col gap-3">
            {errorText ? (
              <Banner kind="error">
                {t("Licence invalide", "Invalid license")} : {errorText}
                {mappedError?.expiry && lic?.expires_at ? ` (${lic.expires_at})` : ""}
              </Banner>
            ) : null}
            <label htmlFor={keyFieldId} className="text-body font-medium">
              {t("Clé de licence", "License key")}
            </label>
            <Textarea
              id={keyFieldId}
              value={key}
              placeholder={t("Coller le jeton de licence…", "Paste the license token…")}
              className="min-h-24 font-mono text-body"
              onChange={(e) => setKey(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={activate} disabled={activating || !key.trim()}>
                {activating ? t("Activation…", "Activating…") : t("Activer", "Activate")}
              </Button>
              <Button
                variant="outline"
                onClick={reset}
                disabled={resetting || (!anyActive && !invalidError)}
              >
                {resetting ? t("Réinitialisation…", "Resetting…") : t("Réinitialiser", "Reset")}
              </Button>
            </div>
            {/* Argument de souveraineté : il vivait dans une branche morte, donc invisible. */}
            <p className="text-caption text-muted-foreground">
              {t(
                "La licence est vérifiée hors-ligne (Ed25519, aucun appel sortant).",
                "The license is verified offline (Ed25519, no outbound call).",
              )}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Catalogue des fonctionnalités Supporter. */}
      <Card>
        <PanelHead
          title={t("Fonctionnalités Supporter", "Supporter features")}
          subtitle={t(
            "Le code de ces modules est DÉJÀ installé dans cette image : la clé les autorise, elle ne télécharge rien.",
            "The code of these modules is ALREADY installed in this image: the key authorises them, it downloads nothing.",
          )}
        />
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {features.map((f) => (
            <div
              key={f.key}
              className="flex flex-col rounded-md border border-border bg-muted/30 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-ui font-medium">{t(f.label_fr, f.label_en)}</span>
                <span className="flex items-center gap-1">
                  {/* « Débloqué » sur un module sans surface d'usage peindrait une promesse
                      en réussite : un module annoncé reste « Prévu », licence ou pas. */}
                  {f.coming_soon ? <Tag tone="muted">{t("Prévu", "Planned")}</Tag> : null}
                  {f.active ? (
                    f.coming_soon ? null : (
                      <Tag tone="green">
                        <Check className="h-3 w-3" />
                        {t("Débloqué", "Unlocked")}
                      </Tag>
                    )
                  ) : (
                    <LockedBadge />
                  )}
                </span>
              </div>
              <p className="mt-1 flex-1 text-body leading-relaxed text-muted-foreground">
                {t(f.description_fr, f.description_en)}
              </p>
              {f.coming_soon ? (
                <p className="mt-2 text-caption text-muted-foreground">
                  {t(
                    "Pas encore de surface d'usage : une licence ne le rend pas utilisable pour autant.",
                    "No usable surface yet: a license does not make it usable either.",
                  )}
                </p>
              ) : !f.active ? (
                <p className="mt-2 text-caption text-muted-foreground">
                  {!f.installed
                    ? t("Code absent de cette image.", "Code missing from this image.")
                    : licensed
                      ? t(
                          "Non incluse dans votre licence actuelle.",
                          "Not included in your current license.",
                        )
                      : t(
                          "Code installé, en attente d'une licence qui l'autorise.",
                          "Code installed, awaiting a license that authorises it.",
                        )}
                </p>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
