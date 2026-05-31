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
  const isEnterprise = lic?.edition === "enterprise";
  // Erreur de licence persistante (clé refusée par le backend → valid:false).
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
        // 200 avec valid:false : la clé est refusée, on garde l'erreur inline.
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
            isEnterprise ? (
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
          {lic?.customer ? (
            <span>
              <span className="text-muted-foreground">{t("Client", "Customer")} : </span>
              <span className="font-medium">{lic.customer}</span>
            </span>
          ) : null}
          {lic?.expires_at ? (
            <span>
              <span className="text-muted-foreground">{t("Expire le", "Expires on")} : </span>
              <span className="font-medium">{lic.expires_at}</span>
            </span>
          ) : null}
          {lic?.issued_at ? (
            <span>
              <span className="text-muted-foreground">{t("Émise le", "Issued on")} : </span>
              <span className="font-medium">{lic.issued_at}</span>
            </span>
          ) : null}
          {!isEnterprise && !lic?.customer ? (
            <span className="text-muted-foreground">
              {t(
                "Édition Community — aucune licence active.",
                "Community edition — no active license.",
              )}
            </span>
          ) : null}
        </CardContent>
      </Card>

      {/* Activation de licence. */}
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
              disabled={resetting || (!isEnterprise && !invalidError)}
            >
              {resetting ? t("Réinitialisation…", "Resetting…") : t("Réinitialiser", "Reset")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Catalogue des fonctionnalités Enterprise. */}
      <Card>
        <PanelHead
          title={t("Fonctionnalités Enterprise", "Enterprise features")}
          subtitle={t(
            "Modules débloqués par licence et présents dans l'image.",
            "Modules unlocked by license and present in the image.",
          )}
        />
        <CardContent className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2">
          {(lic?.features ?? []).map((f) => (
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
