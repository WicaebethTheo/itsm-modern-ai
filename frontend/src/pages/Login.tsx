import { Banner } from "@/components/Banner";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Api, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export function Login() {
  const t = useT();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  // Déjà autorisé (session active, ou admin ouvert via dev_open_admin) → dashboard.
  // Auth non configurée en fail-closed : on RESTE ici avec un bandeau explicite
  // (repartir vers "/" relançait la boucle de redirection 401 → /login → /).
  useEffect(() => {
    Api.authStatus()
      .then((s) => {
        if (s.authenticated) navigate("/", { replace: true });
        else setNotConfigured(!s.auth_configured);
      })
      .catch(() => undefined);
  }, [navigate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await Api.login(password);
      navigate("/", { replace: true });
    } catch (e: unknown) {
      // Seul un 401 signifie « mauvais mot de passe » ; tout le reste (backend down,
      // 502, erreur réseau) mérite son propre message pour ne pas égarer l'admin.
      if (e instanceof ApiError && e.status === 401) {
        setError(t("Mot de passe incorrect.", "Incorrect password."));
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-backdrop flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Logo className="mx-auto h-7 w-7" />
          <CardTitle className="text-base">ITSM Modern AI</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("Console d'administration", "Admin console")}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            {notConfigured && (
              <Banner kind="warning">
                {t(
                  "Aucun mot de passe administrateur configuré. Définissez ITSM_ADMIN_PASSWORD puis redémarrez le moteur.",
                  "No administrator password configured. Set ITSM_ADMIN_PASSWORD and restart the engine.",
                )}
              </Banner>
            )}
            {error && <Banner kind="error">{error}</Banner>}
            <Field label={t("Mot de passe administrateur", "Administrator password")}>
              <Input
                type="password"
                value={password}
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy}>
              {busy ? t("Connexion…", "Signing in…") : t("Se connecter", "Sign in")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
