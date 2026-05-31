import { Banner } from "@/components/Banner";
import { LockedBadge } from "@/components/ui/LockedBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PanelHead } from "@/components/ui/panel";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Check } from "lucide-react";
import { useCallback, useState } from "react";

export function Store() {
  const t = useT();
  const toast = useToast();
  const license = useResource(useCallback(() => Api.getLicense(), []));
  const [key, setKey] = useState("");
  const [activating, setActivating] = useState(false);
  const [resetting, setResetting] = useState(false);

  const lic = license.data;
  const features = lic?.features ?? [];
  // Image Enterprise = le code d'au moins une feature payante est installé. Sur l'image
  // Community, RIEN n'est installé → une clé ne débloque rien : on masque l'activation.
  const enterpriseImage = features.some((f) => f.installed);
  // Badge honnête : "Enterprise" uniquement si une feature est RÉELLEMENT active
  // (installée ET licenciée), pas seulement parce qu'une clé est présente.
  const anyActive = features.some((f) => f.active);
  const invalidError = lic && !lic.valid ? lic.error : null;

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
            "Open-core : l'édition Enterprise se débloque avec une clé — hors-ligne, aucune donnée ne sort.",
            "Open-core: the Enterprise edition unlocks with a key — offline, no data leaves.",
          )}
          right={
            anyActive ? (
              <Tag tone="indigo">
                <Check className="h-3 w-3" />
                Enterprise
              </Tag>
            ) : (
              <Tag tone="muted">Community</Tag>
            )
          }
        />
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-5 text-[12.5px]">
          {anyActive && lic?.customer ? (
            <span>
              <span className="text-muted-foreground">{t("Client", "Customer")} : </span>
              <span className="font-medium">{lic.customer}</span>
            </span>
          ) : null}
          {anyActive && lic?.expires_at ? (
            <span>
              <span className="text-muted-foreground">{t("Expire le", "Expires on")} : </span>
              <span className="font-medium">{lic.expires_at}</span>
            </span>
          ) : null}
          {!anyActive ? (
            <span className="text-muted-foreground">
              {t(
                "Édition Community — fonctionnalités Enterprise verrouillées.",
                "Community edition — Enterprise features locked.",
              )}
            </span>
          ) : null}
        </CardContent>
      </Card>

      {enterpriseImage ? (
        /* Image Enterprise : activation de licence par clé. */
        <Card>
          <PanelHead
            title={t("Activer une licence", "Activate a license")}
            subtitle={t(
              "Collez le jeton fourni à la livraison de votre licence Enterprise.",
              "Paste the token provided with your Enterprise license.",
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
      ) : (
        /* Image Community : pas d'activation (une clé ne débloque rien ici). On guide
           vers la bascule Enterprise. */
        <Card>
          <PanelHead
            title={t("Passer en édition Enterprise", "Upgrade to the Enterprise edition")}
            subtitle={t(
              "Sur l'édition Community, le code des modules payants n'est pas livré : une clé seule ne débloque rien ici.",
              "On the Community edition, the paid modules' code is not shipped: a key alone unlocks nothing here.",
            )}
          />
          <CardContent className="flex flex-col gap-3 p-5 text-[12.5px]">
            <p className="text-muted-foreground">
              {t(
                "La bascule conserve toute votre configuration (même volume de données). Elle remplace l'image par l'édition Enterprise et applique votre clé de licence :",
                "Upgrading keeps your whole configuration (same data volume). It swaps the image for the Enterprise edition and applies your license key:",
              )}
            </p>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[12px]">
              ./upgrade-to-enterprise.sh "{t("<votre-clé>", "<your-key>")}"
            </pre>
            <p className="text-[11.5px] text-muted-foreground/80">
              {t(
                "Détails : docs/enterprise-upgrade.md. La licence est vérifiée hors-ligne (aucun appel sortant).",
                "Details: docs/enterprise-upgrade.md. The license is verified offline (no outbound call).",
              )}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Catalogue des fonctionnalités Enterprise. */}
      <Card>
        <PanelHead
          title={t("Fonctionnalités Enterprise", "Enterprise features")}
          subtitle={t(
            "Modules débloqués par licence sur l'édition Enterprise.",
            "Modules unlocked by license on the Enterprise edition.",
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
                    "Passez en édition Enterprise pour débloquer.",
                    "Switch to the Enterprise edition to unlock.",
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
