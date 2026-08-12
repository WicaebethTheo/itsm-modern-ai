import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Api, type SyncResult } from "@/lib/api";
import { type Lang, localeFor, useLang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Au-delà, le cache est présumé périmé : un acteur parti depuis a pu rester dans la liste. */
const PERIME_JOURS = 30;

const ORDRE_COMPTEURS = ["category", "entity", "technician", "group"] as const;

/** Date lisible d'un horodatage ISO serveur. Renvoie null si illisible (jamais « Invalid Date »). */
function formatDate(iso: string, lang: Lang): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(localeFor(lang), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function joursDepuis(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 86_400_000;
}

/**
 * Bouton « Scanner GLPI » : rafraîchit le cache des référentiels, puis onSynced().
 *
 * Deux corrections de fond ici :
 *
 * 1. **L'échec ne ressemblait plus à un succès.** `POST /api/glpi/sync` répond HTTP 200
 *    avec `ok:false` et un `detail` qui porte la cause EXACTE (« Authentification GLPI
 *    refusée (401) », « Appel GLPI bloqué (anti-SSRF) », « GLPI injoignable ») — c'est le
 *    canal d'erreur le plus riche du produit hors mode debug, et il s'affichait en gris
 *    muté, strictement identique à « Référentiels synchronisés. ».
 * 2. **`SyncResult.counts` n'était plus jeté.** Un scan qui ramène 0 technicien est une
 *    panne de configuration (droits GLPI), pas un succès : le compteur le dit.
 */
export function SyncButton({
  onSynced,
  lastSync,
}: {
  onSynced: () => void;
  /** Horodatage ISO du dernier scan (max `updated_at` des référentiels affichés). */
  lastSync?: string | null;
}) {
  const t = useT();
  const { lang } = useLang();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SyncResult | null>(null);
  const [erreur, setErreur] = useState("");

  async function run() {
    setBusy(true);
    setRes(null);
    setErreur("");
    try {
      const r = await Api.syncGlpi();
      setRes(r);
      if (r.ok) onSynced();
    } catch (e: unknown) {
      // ApiError porte déjà le message backend (detail.message) ou un libellé par status.
      setErreur((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const echec = erreur !== "" || (res !== null && !res.ok);
  const cause = erreur || res?.detail || "";

  const libelles: Record<string, string> = {
    category: t("catégories", "categories"),
    entity: t("entités", "entities"),
    technician: t("techniciens", "technicians"),
    group: t("groupes", "groups"),
  };
  const compteurs = ORDRE_COMPTEURS.filter((k) => res?.counts?.[k] !== undefined).map(
    (k) => `${res?.counts[k]} ${libelles[k]}`,
  );

  const jours = lastSync ? joursDepuis(lastSync) : null;
  const dateLisible = lastSync ? formatDate(lastSync, lang) : null;
  const perime = jours !== null && jours > PERIME_JOURS;

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
      <div className="flex flex-col items-end gap-0.5 text-caption">
        {/* Résultat annoncé aux lecteurs d'écran : c'est la seule restitution d'une action
            qui, en cas d'échec, ne change rien de visible à l'écran. */}
        <span
          role="status"
          aria-live="polite"
          className={cn("text-right", echec ? "font-medium text-destructive" : "text-success")}
        >
          {echec ? (
            <span className="inline-flex items-start gap-1">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              {t(`Scan échoué — ${cause}`, `Scan failed — ${cause}`)}
            </span>
          ) : res ? (
            compteurs.length > 0 ? (
              t(`Synchronisé : ${compteurs.join(", ")}.`, `Synced: ${compteurs.join(", ")}.`)
            ) : (
              res.detail
            )
          ) : (
            ""
          )}
        </span>
        {dateLisible && (
          <span className={cn("text-right", perime ? "text-warning" : "text-muted-foreground")}>
            {perime
              ? t(
                  `Référentiels anciens — relancez un scan (dernière synchro : ${dateLisible}).`,
                  `Stale referentials — run a scan (last sync: ${dateLisible}).`,
                )
              : t(`Dernière synchro : ${dateLisible}`, `Last sync: ${dateLisible}`)}
          </span>
        )}
      </div>
      <Button variant="outline" onClick={run} disabled={busy}>
        <RefreshCw className={`h-4 w-4${busy ? " animate-spin" : ""}`} />{" "}
        {t("Scanner GLPI", "Scan GLPI")}
      </Button>
    </div>
  );
}

/**
 * Horodatage le plus RÉCENT d'une liste de référentiels — la fraîcheur du dernier scan.
 *
 * Lecture défensive : `updated_at` est servi par `/api/discovery/*` mais n'est pas (encore)
 * déclaré sur `RefItem` côté client, et une instance plus ancienne ne le renvoie pas du
 * tout. Absent ⇒ on ne prétend rien, la mention de fraîcheur disparaît simplement.
 */
export function dernierScan(items: readonly unknown[]): string | null {
  let max: string | null = null;
  for (const it of items) {
    const v = (it as { updated_at?: string | null } | null)?.updated_at;
    if (v && (max === null || v > max)) max = v;
  }
  return max;
}
