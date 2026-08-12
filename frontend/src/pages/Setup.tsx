import { Eye, EyeOff, Loader2, Lock, ShieldCheck, Workflow } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthBrandCompact, AuthShell } from "@/components/AuthShell";
import { Banner } from "@/components/Banner";
import { Logo } from "@/components/Logo";
import { PasswordStrength } from "@/components/PasswordStrength";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Api, ApiError, errorCode, MIN_PASSWORD_CHARS, setupSettled } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Première installation : création du compte administrateur DANS l'interface.
 *
 * Le mot de passe admin n'est plus fourni par une variable d'environnement — c'est le
 * tout premier écran du produit, et il doit se comporter comme une application, pas
 * comme un formulaire d'amorçage.
 *
 * PARTI PRIS : UN SEUL ÉCRAN, EN DEUX COLONNES. Un accueil suivi d'un formulaire aurait
 * fait payer un clic pour une information qui tient à côté du formulaire. Le rail de
 * gauche présente le produit (il se lit en premier), la colonne de droite agit — et sur
 * mobile, où le rail disparaîtrait de toute façon, l'identité reste en en-tête compact.
 * Accessoirement : moins de navigation, moins d'occasions de doubler un moteur qui est
 * peut-être encore en train de démarrer.
 *
 * CE QUE CET ÉCRAN N'EST PAS : une page de connexion. Si un compte existe déjà (409, ou
 * `setup_required` faux), on n'insiste pas — on renvoie vers `/login`.
 */

/** Format d'email : volontairement PERMISSIF (le moteur reste l'autorité, cf. 422). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Phase = "checking" | "form" | "unreachable";
type FieldErrors = { email?: string; password?: string; confirm?: string };

export function Setup() {
  const t = useT();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>("checking");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false); // 409 : un compte existe déjà
  const [retryIn, setRetryIn] = useState(0); // 429 : secondes restantes
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // Longueur insuffisante constatée à l'envoi : porté à part des messages de champ,
  // parce que c'est la JAUGE qui l'exprime (cf. `submit`).
  const [tooShort, setTooShort] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  // Sonde d'état : l'installation est-elle encore à faire ? Un compte déjà créé (ou une
  // session ouverte) ne doit pas pouvoir repasser par ici. Extraite en callback parce que
  // le bouton « Réessayer » la rejoue — un `useEffect` ne se relance pas sur commande.
  const probe = useCallback(() => {
    setPhase("checking");
    Api.authStatus()
      .then((s) => {
        if (s.setup_required) setPhase("form");
        else if (s.authenticated) navigate("/", { replace: true });
        else navigate("/login", { replace: true });
      })
      .catch(() => {
        // Le moteur démarre peut-être encore : on le dit, et on offre de réessayer —
        // afficher un formulaire qu'on ne pourra pas soumettre serait un mensonge.
        setPhase("unreachable");
      });
  }, [navigate]);

  useEffect(() => {
    probe();
  }, [probe]);

  // Le formulaire apparu, le curseur est déjà dans le premier champ : on installe, on ne
  // visite pas. (`autoFocus` ne suffit pas : le champ n'est pas monté au premier rendu.)
  useEffect(() => {
    if (phase === "form") emailRef.current?.focus();
  }, [phase]);

  // Décompte du blocage anti-brute-force. Une seconde de tick, pas d'animation : le
  // `prefers-reduced-motion` n'a rien à couper ici, et l'admin sait quand revenir.
  useEffect(() => {
    if (retryIn <= 0) return;
    const id = setInterval(() => setRetryIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [retryIn]);

  /**
   * Une erreur de champ tombe dès que le champ change — pas au prochain envoi. Sinon on
   * corrige sa faute de frappe et le rouge reste, `aria-invalid="true"` avec lui : l'écran
   * a l'air cassé et un lecteur d'écran annonce un champ invalide qui ne l'est plus.
   * (La longueur du mot de passe suit la même règle, portée par `tooShort`.)
   */
  const clearFieldError = useCallback((key: keyof FieldErrors) => {
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }, []);

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    if (!EMAIL_RE.test(email.trim())) {
      errs.email = t("Adresse email invalide.", "Invalid email address.");
    }
    if (confirm !== password) {
      errs.confirm = t(
        "Les deux mots de passe ne correspondent pas.",
        "The two passwords do not match.",
      );
    }
    return errs;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const errs = validate();
    // La longueur est traitée à part : la jauge affiche DÉJÀ « encore N caractères » sous
    // le champ, en continu. Y ajouter une ligne rouge disant la même chose deux lignes
    // plus bas est du bruit — on colore la jauge, qui devient le message d'erreur.
    const short = password.length < MIN_PASSWORD_CHARS;
    setTooShort(short);
    setFieldErrors(errs);
    if (short || Object.keys(errs).length > 0) {
      // Le focus suit l'erreur, dans l'ordre du formulaire — sinon un lecteur d'écran
      // annonce un problème sans dire lequel, et le clavier repart du bouton.
      (errs.email ? emailRef : short ? passwordRef : confirmRef).current?.focus();
      return;
    }
    setBusy(true);
    try {
      const status = await Api.setup({
        email: email.trim(),
        password,
        // Champ facultatif : on ne transmet pas une chaîne vide, qui n'est pas un nom.
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
      });
      if (status.authenticated) navigate("/", { replace: true });
      else navigate("/login", { replace: true });
    } catch (err: unknown) {
      const code = errorCode(err);
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 409 || code === "already_configured") {
        // Le 409 fait foi, même si `/api/auth/status` prétend encore le contraire : sans
        // cette marque, /login nous renverrait ici et les deux pages boucleraient.
        setupSettled.mark();
        setConflict(true);
        // Ce secret ne servira jamais : on ne le laisse pas dans un formulaire qu'on
        // vient de condamner, ni dans une page que l'admin peut laisser ouverte.
        setPassword("");
        setConfirm("");
        setError(
          t(
            "Un compte administrateur existe déjà sur ce moteur.",
            "An administrator account already exists on this engine.",
          ),
        );
      } else if (status === 429 || code === "too_many_attempts") {
        const wait = (err instanceof ApiError && err.retryAfter) || 60;
        setRetryIn(wait);
        setError((err as Error).message);
      } else if (code === "invalid_password") {
        setFieldErrors({ password: (err as Error).message });
        passwordRef.current?.focus();
      } else if (code === "invalid_email") {
        setFieldErrors({ email: (err as Error).message });
        emailRef.current?.focus();
      } else {
        // Panne réseau, 502 d'un proxy, moteur arrêté en cours de route : message dédié,
        // jamais confondu avec un refus de l'installation.
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const tagline = t("Triage IA des tickets GLPI", "AI triage for GLPI tickets");

  const aside = (
    <div className="flex flex-col gap-7">
      <div className="flex items-center gap-2.5">
        <Logo className="h-7 w-7" />
        <div>
          <p className="text-title font-semibold leading-tight tracking-tight">ITSM Modern AI</p>
          <p className="text-caption leading-tight text-muted-foreground">{tagline}</p>
        </div>
      </div>
      <p className="text-ui leading-relaxed text-muted-foreground">
        {t(
          "Le moteur lit vos tickets GLPI, propose une catégorie, une priorité et un technicien — et n'écrit jamais rien hors des limites que vous fixez.",
          "The engine reads your GLPI tickets and suggests a category, a priority and a technician — and never writes anything outside the limits you set.",
        )}
      </p>
      <ul className="flex flex-col gap-4">
        {[
          {
            icon: Workflow,
            fr: "Le LLM propose, le code décide",
            en: "The LLM suggests, the code decides",
            hintFr: "Chaque proposition passe une liste blanche et un seuil de confiance.",
            hintEn: "Every suggestion passes a whitelist and a confidence threshold.",
          },
          {
            icon: Lock,
            fr: "Chez vous, et nulle part ailleurs",
            en: "On your premises, nowhere else",
            hintFr: "Aucun appel sortant hors de GLPI et du fournisseur IA que vous choisissez.",
            hintEn: "No outbound calls beyond GLPI and the AI provider you choose.",
          },
          {
            icon: ShieldCheck,
            fr: "Les données personnelles sont masquées",
            en: "Personal data is masked",
            hintFr: "Le masquage a lieu avant le moindre appel au modèle.",
            hintEn: "Masking happens before any call to the model.",
          },
        ].map((item) => (
          <li key={item.en} className="flex gap-3">
            <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-accent-indigo" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-body font-medium leading-snug">{t(item.fr, item.en)}</p>
              <p className="text-caption leading-snug text-muted-foreground">
                {t(item.hintFr, item.hintEn)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );

  if (phase === "checking") {
    return (
      <AuthShell aside={aside} wide>
        <div className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          <p aria-live="polite" className="text-ui">
            {t("Vérification de l'installation…", "Checking the installation…")}
          </p>
        </div>
      </AuthShell>
    );
  }

  if (phase === "unreachable") {
    return (
      <AuthShell aside={aside} wide>
        <div className="flex h-full min-h-[16rem] flex-col justify-center gap-4">
          <AuthBrandCompact tagline={tagline} />
          <h1 className="text-metric font-semibold tracking-tight">
            {t("Moteur injoignable", "Engine unreachable")}
          </h1>
          <Banner kind="warning">
            {t(
              "Impossible de joindre le moteur. Il termine peut-être son démarrage : réessayez dans quelques secondes.",
              "The engine could not be reached. It may still be starting up: try again in a few seconds.",
            )}
          </Banner>
          <div>
            <Button type="button" onClick={probe}>
              {t("Réessayer", "Try again")}
            </Button>
          </div>
        </div>
      </AuthShell>
    );
  }

  const blocked = retryIn > 0;

  return (
    <AuthShell aside={aside} wide>
      <div className="flex flex-col gap-5 pt-2">
        <AuthBrandCompact tagline={tagline} />

        <div className="flex flex-col gap-1.5">
          <p className="text-caption font-medium uppercase tracking-[0.08em] text-accent-indigo">
            {t("Première installation", "First-time setup")}
          </p>
          <h1 className="text-hero font-semibold leading-tight tracking-tight">
            {t("Bienvenue. Créons votre compte.", "Welcome. Let's create your account.")}
          </h1>
          <p className="text-ui leading-relaxed text-muted-foreground">
            {t(
              "Cette console n'a pas encore d'administrateur. Ce compte sera le seul à pouvoir configurer le moteur — vous pourrez tout régler ensuite depuis l'interface.",
              "This console has no administrator yet. This account will be the only one able to configure the engine — everything else is set up from the interface afterwards.",
            )}
          </p>
        </div>

        {/* La fenêtre de revendication, dite à la SEULE personne qui peut la refermer.
            Le moteur l'écrit dans ses journaux à chaque démarrage ; personne ne les lit
            pendant une première installation. Ton d'avertissement, pas d'alarme : le
            geste demandé (créer le compte, maintenant) EST la contre-mesure. */}
        <Banner kind="warning">
          <p className="font-medium">
            {t(
              "Tant que ce compte n'existe pas, n'importe qui atteignant ce port peut revendiquer l'instance.",
              "Until this account exists, anyone who can reach this port can claim the instance.",
            )}
          </p>
          <p className="mt-1 leading-relaxed">
            {t(
              "Il n'y a ni jeton d'amorçage ni délai qui protège cet écran : c'est un choix délibéré, pour qu'aucun secret ne circule hors de votre réseau. Créez donc le compte maintenant, avant d'exposer ce port au-delà du réseau local.",
              "No bootstrap token and no time window protects this screen: that is a deliberate choice, so that no secret ever travels outside your network. So create the account now, before exposing this port beyond the local network.",
            )}
          </p>
        </Banner>

        {/* Erreurs d'envoi : une seule zone, annoncée dès qu'elle change. */}
        <div aria-live="assertive" className="empty:hidden">
          {error && (
            <Banner kind={conflict ? "info" : "error"}>
              {error}
              {conflict && (
                <>
                  {" "}
                  <Link to="/login" className="font-medium underline underline-offset-2">
                    {t("Se connecter", "Sign in")}
                  </Link>
                </>
              )}
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
          <Field label={t("Adresse email", "Email address")} htmlFor="setup-email">
            <Input
              id="setup-email"
              ref={emailRef}
              type="email"
              value={email}
              autoComplete="username"
              inputMode="email"
              placeholder="admin@exemple.fr"
              aria-invalid={fieldErrors.email ? true : undefined}
              aria-describedby={fieldErrors.email ? "setup-email-error" : undefined}
              onChange={(e) => {
                setEmail(e.target.value);
                clearFieldError("email");
              }}
              disabled={busy || conflict}
            />
            {fieldErrors.email && (
              <p id="setup-email-error" className="text-body leading-snug text-destructive">
                {fieldErrors.email}
              </p>
            )}
          </Field>

          <Field
            label={t("Nom affiché (optionnel)", "Display name (optional)")}
            htmlFor="setup-name"
            hint={t(
              "Utilisé dans l'interface. Sans lui, l'adresse email fait l'affaire.",
              "Used across the interface. Without it, the email address does the job.",
            )}
          >
            <Input
              id="setup-name"
              type="text"
              value={displayName}
              autoComplete="name"
              placeholder={t("Théo, DSI", "Alex, IT dept.")}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={busy || conflict}
            />
          </Field>

          <Field label={t("Mot de passe", "Password")} htmlFor="setup-password">
            <div className="relative">
              <Input
                id="setup-password"
                ref={passwordRef}
                type={reveal ? "text" : "password"}
                value={password}
                autoComplete="new-password"
                className="pr-10"
                aria-invalid={fieldErrors.password || tooShort ? true : undefined}
                // La jauge est TOUJOURS la description du champ : c'est elle qui porte
                // « encore N caractères » puis le verdict. Un message serveur (422)
                // s'y ajoute, il ne la remplace pas.
                aria-describedby={
                  fieldErrors.password
                    ? "setup-password-strength setup-password-error"
                    : "setup-password-strength"
                }
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (tooShort) setTooShort(e.target.value.length < MIN_PASSWORD_CHARS);
                  clearFieldError("password");
                }}
                disabled={busy || conflict}
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                aria-pressed={reveal}
                aria-label={
                  reveal
                    ? t("Masquer le mot de passe", "Hide password")
                    : t("Afficher le mot de passe", "Show password")
                }
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground"
              >
                {reveal ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <PasswordStrength password={password} id="setup-password-strength" invalid={tooShort} />
            {fieldErrors.password && (
              <p id="setup-password-error" className="text-body leading-snug text-destructive">
                {fieldErrors.password}
              </p>
            )}
          </Field>

          <Field
            label={t("Confirmation du mot de passe", "Confirm password")}
            htmlFor="setup-confirm"
          >
            <Input
              id="setup-confirm"
              ref={confirmRef}
              type={reveal ? "text" : "password"}
              value={confirm}
              autoComplete="new-password"
              aria-invalid={fieldErrors.confirm ? true : undefined}
              aria-describedby={fieldErrors.confirm ? "setup-confirm-error" : undefined}
              onChange={(e) => {
                setConfirm(e.target.value);
                clearFieldError("confirm");
              }}
              disabled={busy || conflict}
            />
            {fieldErrors.confirm && (
              <p id="setup-confirm-error" className="text-body leading-snug text-destructive">
                {fieldErrors.confirm}
              </p>
            )}
          </Field>

          {conflict ? (
            <Button type="button" onClick={() => navigate("/login", { replace: true })}>
              {t("Aller à la connexion", "Go to sign-in")}
            </Button>
          ) : (
            <Button type="submit" disabled={busy || blocked}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {busy
                ? t("Création du compte…", "Creating the account…")
                : blocked
                  ? t(`Réessayez dans ${retryIn} s`, `Try again in ${retryIn} s`)
                  : t("Créer le compte et démarrer", "Create the account and start")}
            </Button>
          )}
        </form>

        <p className="text-caption leading-snug text-muted-foreground">
          {t(
            "Le mot de passe est haché (Argon2) puis chiffré au repos. Il n'est stocké nulle part ailleurs, et jamais en clair.",
            "The password is hashed (Argon2) then encrypted at rest. It is stored nowhere else, and never in clear text.",
          )}
        </p>
      </div>
    </AuthShell>
  );
}
