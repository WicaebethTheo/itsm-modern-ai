import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthBrandCompact, AuthShell } from "@/components/AuthShell";
import { Banner } from "@/components/Banner";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Api, ApiError, setupSettled } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function Login() {
  const t = useT();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // Trois issues, et une seule sortie par cas :
  // - déjà autorisé (session active, ou admin ouvert via dev_open_admin) → dashboard ;
  // - aucun compte administrateur → l'installation n'est pas finie → /setup. C'est ce qui
  //   remplace l'ancien bandeau « définissez ITSM_ADMIN_PASSWORD puis redémarrez » : il n'y
  //   a plus rien à faire hors de l'interface, donc plus rien à expliquer ;
  // - sinon on reste ici. Pas de boucle possible : /setup est une route publique qui rend
  //   un formulaire, elle ne renvoie pas ici tant que le compte n'existe pas.
  useEffect(() => {
    Api.authStatus()
      .then((s) => {
        if (s.authenticated) navigate("/", { replace: true });
        else if ((s.setup_required || !s.auth_configured) && !setupSettled.get()) {
          navigate("/setup", { replace: true });
        }
      })
      .catch(() => undefined);
  }, [navigate]);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await Api.login(email.trim(), password);
      navigate("/", { replace: true });
    } catch (e: unknown) {
      // Seul un 401 signifie « identifiants invalides » ; tout le reste (backend down,
      // 502, erreur réseau) mérite son propre message pour ne pas égarer l'admin.
      if (e instanceof ApiError && e.status === 401) {
        setError(t("Identifiants incorrects.", "Incorrect credentials."));
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const tagline = t("Triage IA des tickets GLPI", "AI triage for GLPI tickets");

  const aside = (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2.5">
        <Logo className="h-7 w-7" />
        <div>
          <p className="text-[15px] font-semibold leading-tight tracking-tight">ITSM Modern AI</p>
          <p className="text-[11.5px] leading-tight text-muted-foreground">{tagline}</p>
        </div>
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {t(
          "Console d'administration du moteur. Le triage continue de tourner que vous soyez connecté ou non.",
          "Administration console for the engine. Triage keeps running whether you are signed in or not.",
        )}
      </p>
    </div>
  );

  return (
    <AuthShell aside={aside}>
      <div className="flex min-h-[18rem] flex-col justify-center gap-5 py-4">
        <AuthBrandCompact tagline={tagline} />

        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight">
            {t("Connexion", "Sign in")}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {t("Console d'administration", "Admin console")}
          </p>
        </div>

        <div aria-live="assertive" className="empty:hidden">
          {error && <Banner kind="error">{error}</Banner>}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t("Adresse email", "Email address")} htmlFor="login-email">
            <Input
              id="login-email"
              ref={emailRef}
              type="email"
              value={email}
              autoComplete="username"
              inputMode="email"
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field label={t("Mot de passe", "Password")} htmlFor="login-password">
            <Input
              id="login-password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy ? t("Connexion…", "Signing in…") : t("Se connecter", "Sign in")}
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}
