import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthBrandCompact, AuthShell } from "@/components/AuthShell";
import { Banner } from "@/components/Banner";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Api, ApiError, errorCode, setupSettled } from "@/lib/api";
import { useT } from "@/lib/i18n";

/** Commande de récupération — le SEUL chemin quand le mot de passe est perdu. */
const RESET_CMD = "docker compose exec itsm python -m itsm_modern_ai.admin_setup --force";

export function Login() {
  const t = useT();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryIn, setRetryIn] = useState(0); // 429 : secondes restantes
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

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

  // Décompte du blocage anti-brute-force (429 + Retry-After) : sans lui, le bouton reste
  // actif et l'admin martèle un moteur qui a déjà dit non — chaque coup rallonge l'attente.
  useEffect(() => {
    if (retryIn <= 0) return;
    const id = setInterval(() => setRetryIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [retryIn]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    // Garde PUREMENT LOCALE aux champs vides : un envoi à blanc brûlerait une tentative
    // du compteur anti-brute-force pour rien. Elle ne dit RIEN de l'existence du compte
    // et ne touche pas au traitement du 401 — la réponse reste la même pour « email
    // inconnu » et « mot de passe faux ».
    if (!email.trim()) {
      setError(t("Renseignez votre adresse email.", "Enter your email address."));
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setError(t("Renseignez votre mot de passe.", "Enter your password."));
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await Api.login(email.trim(), password);
      navigate("/", { replace: true });
    } catch (e: unknown) {
      const status = e instanceof ApiError ? e.status : 0;
      // Seul un 401 signifie « identifiants invalides » ; tout le reste (429, backend
      // down, 502, erreur réseau) mérite son propre message pour ne pas égarer l'admin.
      if (status === 401) {
        setError(t("Identifiants incorrects.", "Incorrect credentials."));
      } else if (status === 429 || errorCode(e) === "too_many_attempts") {
        setRetryIn((e instanceof ApiError && e.retryAfter) || 60);
        setError((e as Error).message);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const blocked = retryIn > 0;

  const tagline = t("Triage IA des tickets GLPI", "AI triage for GLPI tickets");

  const aside = (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2.5">
        <Logo className="h-7 w-7" />
        <div>
          <p className="text-title font-semibold leading-tight tracking-tight">ITSM Modern AI</p>
          <p className="text-caption leading-tight text-muted-foreground">{tagline}</p>
        </div>
      </div>
      <p className="text-ui leading-relaxed text-muted-foreground">
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
          <h1 className="text-hero font-semibold leading-tight tracking-tight">
            {t("Connexion", "Sign in")}
          </h1>
          <p className="text-ui text-muted-foreground">
            {t("Console d'administration", "Admin console")}
          </p>
        </div>

        <div aria-live="assertive" className="empty:hidden">
          {error && (
            <Banner kind="error">
              {error}
              {blocked && (
                <>
                  {" "}
                  {t(
                    `Réessayez dans ${retryIn} seconde${retryIn > 1 ? "s" : ""}.`,
                    `Try again in ${retryIn} second${retryIn > 1 ? "s" : ""}.`,
                  )}
                </>
              )}
            </Banner>
          )}
        </div>

        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
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
              ref={passwordRef}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Button type="submit" disabled={busy || blocked}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy
              ? t("Connexion…", "Signing in…")
              : blocked
                ? t(`Réessayez dans ${retryIn} s`, `Try again in ${retryIn} s`)
                : t("Se connecter", "Sign in")}
          </Button>
        </form>

        {/* Mot de passe perdu = compte perdu tant qu'on n'a pas la machine sous la main :
            il n'existe plus d'amorçage par variable d'environnement. Replié par défaut —
            c'est une issue de secours, pas une invitation. */}
        <details className="rounded-md border border-border bg-muted/30 px-3 py-2">
          <summary className="cursor-pointer select-none text-body text-muted-foreground transition-colors hover:text-foreground">
            {t("Mot de passe oublié ?", "Forgot your password?")}
          </summary>
          <div className="mt-2.5 flex flex-col gap-2 text-body leading-relaxed text-muted-foreground">
            <p>
              {t(
                "Il n'y a pas de réinitialisation par email : le moteur n'envoie rien vers l'extérieur. Le seul chemin de récupération passe par la machine qui l'héberge :",
                "There is no reset by email: the engine sends nothing outside. The only recovery path goes through the machine hosting it:",
              )}
            </p>
            <pre className="overflow-x-auto rounded-md border border-border bg-card px-2.5 py-2 font-mono text-caption leading-relaxed text-foreground">
              {RESET_CMD}
            </pre>
            <p>
              {t(
                "Elle redéfinit le compte administrateur ; le mot de passe est saisi de façon masquée, jamais passé en variable d'environnement.",
                "It redefines the administrator account; the password is typed in masked, never passed as an environment variable.",
              )}
            </p>
          </div>
        </details>
      </div>
    </AuthShell>
  );
}
