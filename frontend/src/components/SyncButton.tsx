import { Button } from "@/components/ui/button";
import { Api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

/** Bouton « Scanner GLPI » : rafraîchit le cache des référentiels, puis onSynced(). */
export function SyncButton({ onSynced }: { onSynced: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function run() {
    setBusy(true);
    setMsg("");
    try {
      const r = await Api.syncGlpi();
      setMsg(r.ok ? t("Référentiels synchronisés.", "Referentials synced.") : r.detail);
      if (r.ok) onSynced();
    } catch (e: unknown) {
      // ApiError porte déjà le message backend (detail.message) ou un libellé par status.
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      <Button variant="outline" onClick={run} disabled={busy}>
        <RefreshCw className={`h-4 w-4${busy ? " animate-spin" : ""}`} />{" "}
        {t("Scanner GLPI", "Scan GLPI")}
      </Button>
    </div>
  );
}
