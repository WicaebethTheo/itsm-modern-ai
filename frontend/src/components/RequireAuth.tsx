import { Layout } from "@/components/Layout";
import { Api } from "@/lib/api";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

/**
 * Garde d'authentification (FR-24). Si un mot de passe admin est configuré côté
 * serveur et qu'aucune session n'est active, on redirige vers /login. Sinon
 * (pilote sans mot de passe, ou déjà connecté) on rend l'application.
 */
export function RequireAuth() {
  const [state, setState] = useState<"loading" | "ok" | "redirect">("loading");

  useEffect(() => {
    Api.authStatus()
      .then((s) => setState(!s.auth_configured || s.authenticated ? "ok" : "redirect"))
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
