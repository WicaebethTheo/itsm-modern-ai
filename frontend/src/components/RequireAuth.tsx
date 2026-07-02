import { Layout } from "@/components/Layout";
import { Api } from "@/lib/api";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

/**
 * Garde d'authentification (FR-24). On se fie à `authenticated` SEUL : le backend
 * y reflète les mêmes règles d'accès que ses endpoints (session active, ou admin
 * ouvert via dev_open_admin). Déduire « non configuré = ouvert » côté UI alors que
 * l'API est fail-closed créait une boucle de redirection Layout → 401 → /login → /.
 */
export function RequireAuth() {
  const [state, setState] = useState<"loading" | "ok" | "redirect">("loading");

  useEffect(() => {
    Api.authStatus()
      .then((s) => setState(s.authenticated ? "ok" : "redirect"))
      .catch(() => setState("redirect"));
  }, []);

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (state === "redirect") return <Navigate to="/login" replace />;
  return <Layout />;
}
