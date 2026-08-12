import { Eye, EyeOff, KeyRound, Loader2, UserCog } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banner } from "@/components/Banner";
import { PasswordStrength } from "@/components/PasswordStrength";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PanelHead } from "@/components/ui/panel";
import { useResource } from "@/hooks/useResource";
import { Api, ApiError, errorCode, MIN_PASSWORD_CHARS } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * « Compte & sécurité » — au SINGULIER, et ce n'est pas une coquille.
 *
 * Le mono-compte est un choix ASSUMÉ du produit (cf. `services/runtime_config.py` : « une
 * table users pour une seule ligne serait un schéma à maintenir pour rien »). Cette page ne
 * propose donc NI création d'un second compte, NI rôles, NI invitation — elle montre le
 * compte qui existe, et permet d'en changer le secret.
 *
 * LE POINT DÉLICAT : la rotation du mot de passe incrémente la génération de session côté
 * moteur. TOUTES les sessions tombent, y compris celle qui vient de faire la demande. C'est
 * voulu (un cookie volé ne survit pas au changement) — donc on l'annonce AVANT de valider,
 * on le redit APRÈS, et on renvoie vers `/login` sans faire semblant que la session tient.
 */

type FieldErrors = { current?: string; next?: string; confirm?: string };

/** Délai avant le renvoi vers /login : le temps de lire que les sessions sont fermées. */
const REDIRECT_MS = 2500;

export function Account() {
  const t = useT();
  const navigate = useNavigate();
  const me = useResource(useCallback(() => Api.me(), []));

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [retryIn, setRetryIn] = useState(0); // 429 : secondes restantes
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // Longueur insuffisante : portée par la JAUGE (comme à l'installation), pas par une
  // seconde ligne rouge qui répéterait « encore N caractères » deux lignes plus bas.
  const [tooShort, setTooShort] = useState(false);

  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  // Décompte du blocage anti-brute-force (même limiteur que /login côté moteur).
  useEffect(() => {
    if (retryIn <= 0) return;
    const id = setInterval(() => setRetryIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [retryIn]);

  // Succès : la session courante est morte avec les autres, rester ici n'aurait aucun sens.
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => navigate("/login", { replace: true }), REDIRECT_MS);
    return () => clearTimeout(id);
  }, [done, navigate]);

  const email = me.data?.email || "";
  const displayName = me.data?.display_name || "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const errs: FieldErrors = {};
    if (!current) {
      errs.current = t("Saisissez votre mot de passe actuel.", "Enter your current password.");
    }
    if (confirm !== next) {
      errs.confirm = t(
        "Les deux mots de passe ne correspondent pas.",
        "The two passwords do not match.",
      );
    }
    const short = next.length < MIN_PASSWORD_CHARS;
    setTooShort(short);
    setFieldErrors(errs);
    if (short || Object.keys(errs).length > 0) {
      (errs.current ? currentRef : short ? nextRef : confirmRef).current?.focus();
      return;
    }

    setBusy(true);
    try {
      await Api.changePassword(current, next);
      // Aucun de ces secrets n'a plus de raison d'être en mémoire d'un formulaire.
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err: unknown) {
      const code = errorCode(err);
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 429 || code === "too_many_attempts") {
        setRetryIn((err instanceof ApiError && err.retryAfter) || 60);
        setError((err as Error).message);
      } else if (status === 401 || code === "bad_credentials") {
        setFieldErrors({
          current: t("Mot de passe actuel incorrect.", "Current password is incorrect."),
        });
        currentRef.current?.focus();
      } else if (code === "invalid_password") {
        setFieldErrors({ next: (err as Error).message });
        nextRef.current?.focus();
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const blocked = retryIn > 0;

  return (
    <div className="max-w-2xl space-y-6">
      {/* ── Identité du compte ───────────────────────────────────────────── */}
      <Card>
        <PanelHead
          title={
            <span className="flex items-center gap-2">
              <UserCog className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {t("Le compte administrateur", "The administrator account")}
            </span>
          }
          subtitle={t(
            "Ce moteur n'a qu'un seul compte, et c'est un choix : il n'y a ni rôles ni invitations à gérer. L'adresse sert d'identifiant de connexion.",
            "This engine has a single account, by design: there are no roles and no invitations to manage. The address is the sign-in identifier.",
          )}
        />
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-[11.5px] uppercase tracking-wide text-muted-foreground">
                {t("Adresse email", "Email address")}
              </dt>
              <dd className="truncate text-[13.5px]">
                {me.loading ? "…" : email || t("inconnue", "unknown")}
              </dd>
            </div>
            <div>
              <dt className="text-[11.5px] uppercase tracking-wide text-muted-foreground">
                {t("Nom affiché", "Display name")}
              </dt>
              <dd className="truncate text-[13.5px]">
                {me.loading ? "…" : displayName || t("(aucun)", "(none)")}
              </dd>
            </div>
          </dl>
          <p className="pt-3 text-[11.5px] leading-snug text-muted-foreground">
            {t(
              "L'adresse et le nom se changent depuis le moteur : docker compose exec itsm python -m itsm_modern_ai.admin_setup --email nouvelle@adresse.fr --email-only",
              "The address and name are changed from the engine: docker compose exec itsm python -m itsm_modern_ai.admin_setup --email new@address.com --email-only",
            )}
          </p>
        </CardContent>
      </Card>

      {/* ── Rotation du mot de passe ─────────────────────────────────────── */}
      <Card>
        <PanelHead
          title={
            <span className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {t("Changer le mot de passe", "Change the password")}
            </span>
          }
          subtitle={t(
            "Le mot de passe actuel est redemandé : une session ouverte ne suffit pas à s'approprier le compte.",
            "The current password is asked again: an open session is not enough to take over the account.",
          )}
        />
        <CardContent>
          <div aria-live="assertive" className="empty:hidden">
            {done ? (
              <Banner kind="success">
                {t(
                  "Mot de passe changé. Toutes vos sessions sont fermées, sur cet appareil comme sur les autres — reconnectez-vous avec le nouveau mot de passe.",
                  "Password changed. All your sessions are closed, on this device and on any other — sign in again with the new password.",
                )}
              </Banner>
            ) : error ? (
              <Banner kind="error">
                {error}
                {blocked ? (
                  <>
                    {" "}
                    {t(
                      `Réessayez dans ${retryIn} seconde${retryIn > 1 ? "s" : ""}.`,
                      `Try again in ${retryIn} second${retryIn > 1 ? "s" : ""}.`,
                    )}
                  </>
                ) : null}
              </Banner>
            ) : null}
          </div>

          {done ? (
            <div className="pt-4">
              <Button type="button" onClick={() => navigate("/login", { replace: true })}>
                {t("Aller à la connexion", "Go to sign-in")}
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="flex flex-col gap-4 pt-2">
              <Field label={t("Mot de passe actuel", "Current password")} htmlFor="account-current">
                <Input
                  id="account-current"
                  ref={currentRef}
                  type={reveal ? "text" : "password"}
                  value={current}
                  autoComplete="current-password"
                  aria-invalid={fieldErrors.current ? true : undefined}
                  aria-describedby={fieldErrors.current ? "account-current-error" : undefined}
                  onChange={(e) => setCurrent(e.target.value)}
                  disabled={busy}
                />
                {fieldErrors.current ? (
                  <p id="account-current-error" className="text-xs leading-snug text-destructive">
                    {fieldErrors.current}
                  </p>
                ) : null}
              </Field>

              <Field label={t("Nouveau mot de passe", "New password")} htmlFor="account-new">
                <div className="relative">
                  <Input
                    id="account-new"
                    ref={nextRef}
                    type={reveal ? "text" : "password"}
                    value={next}
                    autoComplete="new-password"
                    className="pr-10"
                    aria-invalid={fieldErrors.next || tooShort ? true : undefined}
                    aria-describedby={
                      fieldErrors.next
                        ? "account-new-strength account-new-error"
                        : "account-new-strength"
                    }
                    onChange={(e) => {
                      setNext(e.target.value);
                      if (tooShort) setTooShort(e.target.value.length < MIN_PASSWORD_CHARS);
                    }}
                    disabled={busy}
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
                <PasswordStrength password={next} id="account-new-strength" invalid={tooShort} />
                {fieldErrors.next ? (
                  <p id="account-new-error" className="text-xs leading-snug text-destructive">
                    {fieldErrors.next}
                  </p>
                ) : null}
              </Field>

              <Field
                label={t("Confirmation du nouveau mot de passe", "Confirm the new password")}
                htmlFor="account-confirm"
              >
                <Input
                  id="account-confirm"
                  ref={confirmRef}
                  type={reveal ? "text" : "password"}
                  value={confirm}
                  autoComplete="new-password"
                  aria-invalid={fieldErrors.confirm ? true : undefined}
                  aria-describedby={fieldErrors.confirm ? "account-confirm-error" : undefined}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                />
                {fieldErrors.confirm ? (
                  <p id="account-confirm-error" className="text-xs leading-snug text-destructive">
                    {fieldErrors.confirm}
                  </p>
                ) : null}
              </Field>

              {/* Prévenu AVANT de valider : personne ne doit découvrir après coup qu'il
                  vient de se déconnecter de partout. */}
              <p className="text-[11.5px] leading-snug text-muted-foreground">
                {t(
                  "Après le changement, toutes les sessions ouvertes sont fermées — y compris celle-ci. Vous serez renvoyé vers l'écran de connexion.",
                  "After the change, every open session is closed — including this one. You will be sent back to the sign-in screen.",
                )}
              </p>

              <div>
                <Button type="submit" disabled={busy || blocked}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                  {busy
                    ? t("Changement en cours…", "Changing…")
                    : blocked
                      ? t(`Réessayez dans ${retryIn} s`, `Try again in ${retryIn} s`)
                      : t("Changer le mot de passe", "Change the password")}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
