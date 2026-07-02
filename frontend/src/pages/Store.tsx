import { Banner } from "@/components/Banner";
import { LockedBadge } from "@/components/ui/LockedBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api, updateCommand } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Check } from "lucide-react";
import { useCallback, useState } from "react";

export function Store() {
  const t = useT();
  const toast = useToast();
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
  // Le code des features Supporter est présent dès qu'au moins une feature est installée.
  // L'image unique embarque toujours le code → une clé valide suffit à débloquer.
  const supporterCodePresent = features.some((f) => f.installed);
  // Badge honnête : "Supporter" uniquement si une feature est RÉELLEMENT active
  // (installée ET licenciée), pas seulement parce qu'une clé est présente.
  const anyActive = features.some((f) => f.active);
  const invalidError = lic && !lic.valid ? lic.error : null;
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
      {/* Bandeau d'édition : badge + client + expiration. */}
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
        <CardContent className="p-5 text-[12.5px]">
          <span className="text-muted-foreground">
            {anyActive
              ? t(
                  "Licence Supporter active — détails de la licence ci-dessous.",
                  "Supporter license active — license details below.",
                )
              : t(
                  "Édition Community — fonctionnalités Supporter verrouillées.",
                  "Community edition — Supporter features locked.",
                )}
          </span>
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
          <CardContent className="flex flex-col gap-3 p-5">
            {ver.latest_notes ? (
              <div className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-3 text-[12px] leading-relaxed text-muted-foreground">
                {ver.latest_notes}
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <pre className="flex-1 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[12px]">
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
              className="text-[12px] text-accent-indigo hover:underline"
            >
              {t("Voir toutes les notes de version", "View all release notes")}
            </a>
          </CardContent>
        </Card>
      ) : null}

      {supporterCodePresent ? (
        anyActive ? (
          /* Licence ACTIVE : statut + renouvellement (remplacer par une nouvelle clé). */
          <Card>
            <PanelHead
              title={t("Licence active", "Active license")}
              subtitle={t(
                "Licence Supporter valide. Renouvelez-la avec une nouvelle clé avant l'expiration.",
                "Valid Supporter license. Renew it with a new key before it expires.",
              )}
              right={
                <Tag tone="green">
                  <Check className="h-3 w-3" />
                  {t("Active", "Active")}
                </Tag>
              }
            />
            <CardContent className="flex flex-col gap-3 p-5 text-[12.5px]">
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
                  <Textarea
                    value={key}
                    placeholder={t("Coller la nouvelle clé…", "Paste the new key…")}
                    className="min-h-24 font-mono text-[12px]"
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
          /* Code Supporter présent SANS licence valide (absente ou EXPIRÉE) : activation/renouvellement. */
          <Card>
            <PanelHead
              title={t("Activer une licence", "Activate a license")}
              subtitle={t(
                "Collez le jeton fourni à la livraison (ou une clé renouvelée si la précédente a expiré).",
                "Paste the token provided with your license (or a renewed key if the previous one expired).",
              )}
            />
            <CardContent className="flex flex-col gap-3 p-5">
              {invalidError ? (
                <Banner kind="error">
                  {t("Licence invalide", "Invalid license")} : {invalidError}
                  {lic?.expires_at && invalidError.includes("expir") ? ` (${lic.expires_at})` : ""}
                </Banner>
              ) : null}
              <Textarea
                value={key}
                placeholder={t("Coller le jeton de licence…", "Paste the license token…")}
                className="min-h-24 font-mono text-[12px]"
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
            </CardContent>
          </Card>
        )
      ) : (
        /* Code Supporter absent de l'image (cas démo Community) : on guide vers
           l'activation d'une licence Supporter. */
        <Card>
          <PanelHead
            title={t("Activer ma licence Supporter", "Activate my Supporter license")}
            subtitle={t(
              "Collez la clé fournie pour débloquer les fonctionnalités Supporter — vérification hors-ligne, aucune donnée ne sort.",
              "Paste the key you were provided to unlock Supporter features — offline verification, no data leaves.",
            )}
          />
          <CardContent className="flex flex-col gap-3 p-5">
            {invalidError ? (
              <Banner kind="error">
                {t("Licence invalide", "Invalid license")} : {invalidError}
              </Banner>
            ) : null}
            <Textarea
              value={key}
              placeholder={t("Coller le jeton de licence…", "Paste the license token…")}
              className="min-h-24 font-mono text-[12px]"
              onChange={(e) => setKey(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={activate} disabled={activating || !key.trim()}>
                {activating
                  ? t("Activation…", "Activating…")
                  : t("Activer ma licence Supporter", "Activate Supporter license")}
              </Button>
            </div>
            <p className="text-[11.5px] text-muted-foreground/80">
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
            "Modules débloqués par une licence Supporter.",
            "Modules unlocked by a Supporter license.",
          )}
        />
        <CardContent className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2">
          {features.map((f) => (
            <div
              key={f.key}
              className="flex flex-col rounded-md border border-border bg-muted/20 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{t(f.label_fr, f.label_en)}</span>
                {f.active ? (
                  <Tag tone="green">
                    <Check className="h-3 w-3" />
                    {t("Débloqué", "Unlocked")}
                  </Tag>
                ) : (
                  <LockedBadge />
                )}
              </div>
              <p className="mt-1 flex-1 text-[12px] leading-relaxed text-muted-foreground">
                {t(f.description_fr, f.description_en)}
              </p>
              {!f.active ? (
                <p className="mt-2 text-[11px] text-muted-foreground/80">
                  {t(
                    "Activez votre licence Supporter pour débloquer.",
                    "Activate your Supporter license to unlock.",
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
