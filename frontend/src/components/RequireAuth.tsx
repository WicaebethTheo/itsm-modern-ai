import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { Api, setupSettled } from "@/lib/api";

/**
 * Garde d'authentification (FR-24). On se fie à `authenticated` SEUL : le backend
 * y reflète les mêmes règles d'accès que ses endpoints (session active, ou admin
 * ouvert via dev_open_admin). Déduire « non configuré = ouvert » côté UI alors que
 * l'API est fail-closed créait une boucle de redirection Layout → 401 → /login → /.
 */
export function RequireAuth() {
  const [state, setState] = useState<"loading" | "ok" | "setup" | "redirect">("loading");

  useEffect(() => {
    Api.authStatus()
      .then((s) =>
        // Aucun compte administrateur → l'installation n'est pas terminée : envoyer sur
        // /login n'y offrirait qu'un formulaire que personne ne peut satisfaire. Sauf si
        // un 409 a déjà démenti ce statut dans cet onglet (cf. `setupSettled`).
        setState(
          s.authenticated ? "ok" : s.setup_required && !setupSettled.get() ? "setup" : "redirect",
        ),
      )
      .catch(() => setState("redirect"));
  }, []);

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (state === "setup") return <Navigate to="/setup" replace />;
  if (state === "redirect") return <Navigate to="/login" replace />;
  return <Layout />;
}
