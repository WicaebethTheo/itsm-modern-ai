import { ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banner } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Api } from "@/lib/api";

export function Login() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Si l'auth n'est pas configurée (pilote) ou déjà connecté, aller au dashboard.
  useEffect(() => {
    Api.authStatus()
      .then((s) => {
        if (!s.auth_configured || s.authenticated) navigate("/", { replace: true });
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
    } catch {
      setError("Mot de passe incorrect.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <ShieldCheck className="mx-auto h-7 w-7 text-primary" />
          <CardTitle>ITSM Modern AI</CardTitle>
          <p className="text-sm text-muted-foreground">Console d'administration</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            {error && <Banner kind="error">{error}</Banner>}
            <Field label="Mot de passe administrateur">
              <Input
                type="password"
                value={password}
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy}>
              {busy ? "Connexion…" : "Se connecter"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
