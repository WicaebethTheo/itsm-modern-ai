import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useResource } from "@/hooks/useResource";
import { Api, type ConfigUpdate, type ConfigView } from "@/lib/api";
import { tr } from "@/lib/i18n";

/**
 * Un brouillon de configuration, sa garde anti-écrasement et son enregistrement PARTIEL.
 *
 * Ce hook existe parce que la page « Moteur » a été découpée en quatre écrans. Sans lui,
 * chacun recopierait la même mécanique — et c'est précisément le genre de logique dont une
 * copie sur quatre finit par diverger sans que personne ne s'en aperçoive.
 *
 * Il porte trois choses qu'un écran de réglages ne peut pas se permettre de rater :
 *
 * 1. **La fusion, jamais l'écrasement.** `save()` déclenche une relecture qu'il ne peut pas
 *    attendre (`useResource.reload` ne rend pas de promesse) : sans le drapeau `edite`, ce
 *    qui était tapé pendant l'aller-retour se faisait écraser SANS UN MOT à l'arrivée de la
 *    réponse. Le drapeau est baissé juste avant la relecture — une saisie faite APRÈS ce
 *    point le rearme et survit.
 *
 * 2. **L'enregistrement partiel.** `toPayload` ne rend QUE les clés de l'écran, et
 *    `ConfigUpdate` est un patch (`exclude_none=True` côté serveur). Auparavant une seule
 *    page renvoyait les dix-sept réglages d'un coup : deux onglets ouverts se réécrivaient
 *    l'un l'autre en silence. Découpé, chaque écran ne peut plus écrire que chez lui.
 *
 * 3. **« Modifié » comme une DIFFÉRENCE avec le serveur**, jamais comme un drapeau posé au
 *    premier caractère : revenir à la valeur d'origine doit re-désarmer le bouton.
 *
 * `toDraft` et `toPayload` doivent être stables — donc définies au niveau du module, jamais
 * dans le corps du composant.
 */
export interface ConfigDraft<D> {
  /** Config serveur ; `null` tant qu'elle n'est pas lue (ou si la lecture a échoué). */
  config: ConfigView | null;
  /** Message d'erreur de LECTURE. Un formulaire muet dont on enregistrerait les défauts
   *  locaux écraserait la config réelle : l'écran doit le dire. */
  error: string | null;
  draft: D;
  /** La config enregistrée, projetée en brouillon — la référence de « modifié ». */
  saved: D;
  dirty: boolean;
  saving: boolean;
  patch: (p: Partial<D>) => void;
  /**
   * `garde` peut refuser l'enregistrement (confirmation déclinée) en rendant `false`.
   *
   * Rend `true` UNIQUEMENT si le serveur a accepté. Sans cette valeur, un appelant qui
   * enchaîne sur `save()` — pour relire une ressource voisine, par exemple — le faisait
   * aussi bien après un échec : la page se rafraîchissait comme après un succès, ce qui
   * accrédite l'idée que l'enregistrement a eu lieu. Et le chemin d'échec, n'étant pas
   * distinguable, n'était testable nulle part.
   */
  save: (garde?: () => boolean) => Promise<boolean>;
}

export function useConfigDraft<D>(
  toDraft: (c: ConfigView | null) => D,
  toPayload: (d: D) => ConfigUpdate,
  succes: string,
): ConfigDraft<D> {
  const toast = useToast();
  const cfg = useResource(useCallback(() => Api.getConfig(), []));
  const c = cfg.data;

  // Les deux projections sont FIGÉES au premier rendu, et c'est un garde-fou, pas une
  // optimisation. Placées dans les dépendances du `useMemo` et de l'effet ci-dessous, une
  // projection recréée à chaque rendu — c'est-à-dire définie dans le corps du composant
  // appelant au lieu du module — bouclait : nouvelle identité → effet → `setDraft` → rendu
  // → nouvelle identité. Mesuré : « Maximum update depth exceeded », vingt-sept fois. React
  // finit par couper la boucle, donc la page s'affiche et seule la console hurle : le pire
  // symptôme, celui qu'on ne voit pas. Le contrat n'était tenu que par un commentaire ; il
  // l'est désormais par le code, quelle que soit la façon dont un appelant les passe.
  const proj = useRef({ toDraft, toPayload });

  const [draft, setDraft] = useState<D>(() => proj.current.toDraft(null));
  const [saving, setSaving] = useState(false);
  const saved = useMemo(() => proj.current.toDraft(c), [c]);
  const edite = useRef(false);

  useEffect(() => {
    if (c && !edite.current) setDraft(proj.current.toDraft(c));
  }, [c]);

  // Dernière identité de brouillon connue, lisible depuis une clôture asynchrone.
  const dernierDraft = useRef(draft);
  dernierDraft.current = draft;

  const patch = useCallback((p: Partial<D>) => {
    edite.current = true;
    setDraft((d) => ({ ...d, ...p }));
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = useCallback(
    async (garde?: () => boolean): Promise<boolean> => {
      if (garde && !garde()) return false;
      setSaving(true);
      // Le brouillon TEL QU'ENVOYÉ. La garde ci-dessous compare la fin de l'appel à ce
      // point de départ ; `draft` seul ne le permet pas, il est figé dans cette clôture.
      const envoye = draft;
      try {
        await Api.updateConfig(proj.current.toPayload(envoye));
        // Le serveur redevient la référence : il a pu NORMALISER une valeur, la relecture
        // doit pouvoir la ramener.
        //
        // MAIS seulement si rien n'a été tapé PENDANT l'appel. Les champs ne sont pas
        // désactivés le temps du POST : baisser le drapeau inconditionnellement, c'était
        // autoriser la relecture à écraser une saisie faite entre le clic et la réponse —
        // sans un mot, et sur la moitié précisément que le commentaire ci-dessus promet de
        // protéger. La garde ne couvrait que l'autre moitié (la saisie pendant le GET).
        if (dernierDraft.current === envoye) edite.current = false;
        cfg.reload();
        toast.success(succes);
        return true;
      } catch (e: unknown) {
        toast.error(`${tr("Erreur", "Error")} : ${(e as Error).message}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [draft, cfg.reload, toast, succes],
  );

  return { config: c, error: cfg.error, draft, saved, dirty, saving, patch, save };
}
