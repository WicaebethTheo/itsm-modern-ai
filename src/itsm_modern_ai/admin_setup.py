"""Compte administrateur (FR-24) — logique partagée + CLI de RÉCUPÉRATION.

Le compte se crée normalement **dans l'interface, à la première visite** (POST
`/api/auth/setup`). Cette CLI reste le **seul chemin de récupération** : mot de passe
oublié, adresse à corriger, hash illisible après une rotation de MASTER_KEY. Sans elle, la
seule issue serait de repartir d'une base vierge.

Stocke le mot de passe **en base** sous forme de hash Argon2 chiffré Fernet — **aucun mot
de passe en clair** n'est conservé (ni `.env`, ni log, ni historique shell). L'email et le
nom affiché vivent à côté, en clair mais sous des clés réservées (cf. `runtime_config`).

Usage (typiquement `docker compose exec app …`) :
    python -m itsm_modern_ai.admin_setup --email admin@exemple.fr   # création
    python -m itsm_modern_ai.admin_setup --force                    # nouveau mot de passe
    python -m itsm_modern_ai.admin_setup --email a@b.fr --email-only  # adresse seulement
    python -m itsm_modern_ai.admin_setup --check                    # 0 si configuré, 1 sinon

Source du mot de passe, par ordre de priorité :
  1. stdin si l'entrée est un pipe (non-interactif / CI) ;
  2. saisie masquée interactive (getpass) + confirmation.

⚠️ Il n'y a **plus** de lecture de `ITSM_ADMIN_PASSWORD`. C'était le premier maillon lu, et
c'était un bug mesuré : dans un conteneur qui portait encore la variable, `--force`
réinstallait silencieusement le MÊME mot de passe puis affichait « ✓ enregistré » —
l'ancien mot de passe continuait donc d'authentifier, et l'admin croyait l'avoir changé.
"""

from __future__ import annotations

import argparse
import getpass
import sys

from .adapters.secrets.encrypted import FernetSecretsBox
from .api.security import (
    DISPLAY_NAME_MAX_CHARS,
    HASH_KEY,
    MIN_ADMIN_CHARS,
    email_is_valid,
    hash_password,
    normalize_email,
    revoke_sessions,
)
from .config.settings import get_settings
from .persistence import db
from .services.runtime_config import RuntimeConfigService

# Source de vérité UNIQUE de la politique de mot de passe : `api.security`. Alias conservé
# pour ne pas casser les appelants/tests existants.
MIN_LEN = MIN_ADMIN_CHARS


class AdminSetupError(Exception):
    """Erreur fonctionnelle (message clair, pas de stack).

    Porte un `code` STABLE, repris tel quel par `/api/auth/setup` dans `detail.code` — le
    frontend s'en sert pour viser le bon champ du formulaire. Les codes sont donc un
    contrat d'API : `invalid_password`, `invalid_email`, `already_configured`.
    """

    def __init__(self, message: str, code: str = "invalid_password") -> None:
        super().__init__(message)
        self.code = code


def set_admin_password(
    cfg: RuntimeConfigService,
    plaintext: str,
    *,
    force: bool = False,
    email: str | None = None,
    display_name: str | None = None,
) -> None:
    """Valide puis stocke le compte admin. Idempotence contrôlée par `force`.

    Tout est validé AVANT la moindre écriture : un email invalide ne doit pas laisser
    derrière lui un hash à moitié posé, sinon la seconde tentative se heurterait à
    « déjà configuré » sur un compte dont personne ne connaît l'adresse.
    """
    if len(plaintext) < MIN_LEN:
        raise AdminSetupError(
            f"Mot de passe trop court (minimum {MIN_LEN} caractères).", code="invalid_password"
        )
    canonical: str | None = None
    if email is not None:
        canonical = normalize_email(email)
        if not email_is_valid(canonical):
            raise AdminSetupError("Adresse email invalide.", code="invalid_email")
    if cfg.is_secret_set(HASH_KEY) and not force:
        raise AdminSetupError(
            "Un compte administrateur est déjà configuré sur ce moteur.",
            code="already_configured",
        )
    cfg.set_secret(HASH_KEY, hash_password(plaintext))
    if canonical is not None:
        cfg.set_admin_identity(canonical, (display_name or "").strip()[:DISPLAY_NAME_MAX_CHARS])
    # Un changement de mot de passe DOIT invalider les sessions en cours : sinon un cookie
    # déjà volé survit à la rotation, et le seul recours resterait de changer MASTER_KEY
    # (tous les secrets chiffrés deviennent illisibles, console verrouillée).
    revoke_sessions(cfg)


def _read_password() -> str:
    """Mot de passe saisi EXPLICITEMENT : stdin (pipe) d'abord, sinon saisie masquée.

    L'environnement n'est plus consulté — cf. l'avertissement en tête de module.
    """
    if not sys.stdin.isatty():
        line = sys.stdin.readline()
        if not line:
            raise AdminSetupError("Aucun mot de passe reçu sur stdin.")
        return line.rstrip("\n")
    pw = getpass.getpass("Mot de passe administrateur : ")
    confirm = getpass.getpass("Confirmez le mot de passe : ")
    if pw != confirm:
        raise AdminSetupError("Les mots de passe ne correspondent pas.")
    return pw


def _validated_email(raw: str) -> str:
    canonical = normalize_email(raw)
    if not email_is_valid(canonical):
        raise AdminSetupError("Adresse email invalide.", code="invalid_email")
    return canonical


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="itsm_modern_ai.admin_setup",
        description=(
            "Compte administrateur (hash Argon2 chiffré en base). Chemin de RÉCUPÉRATION : "
            "en usage normal, le compte se crée dans l'interface à la première visite."
        ),
    )
    parser.add_argument("--force", action="store_true", help="Remplace un compte existant.")
    parser.add_argument(
        "--check", action="store_true", help="N'écrit rien : sort 0 si déjà configuré, 1 sinon."
    )
    parser.add_argument(
        "--email",
        default=None,
        help="Adresse de connexion (obligatoire à la création, facultative ensuite).",
    )
    parser.add_argument(
        "--email-only",
        action="store_true",
        help="Ne change QUE l'adresse : aucun mot de passe demandé, sessions préservées.",
    )
    parser.add_argument("--display-name", default=None, help="Nom affiché dans l'interface.")
    args = parser.parse_args(argv)

    settings = get_settings()
    db.init_engine(settings.database_url)
    secrets = FernetSecretsBox(master_key=settings.master_key)

    if args.check:
        with db.session_scope() as session:
            is_set = RuntimeConfigService(session, secrets, settings).is_secret_set(HASH_KEY)
        print("configuré" if is_set else "non configuré")
        return 0 if is_set else 1

    try:
        # État lu dans une session COURTE, refermée avant la saisie : un `getpass` peut
        # attendre des minutes, et une session ouverte pendant ce temps garde une connexion
        # « idle in transaction » (donc des verrous) sur la base de production.
        with db.session_scope() as session:
            cfg = RuntimeConfigService(session, secrets, settings)
            deja_configure = cfg.is_secret_set(HASH_KEY)
            email_existant = cfg.admin_email()

        if args.email_only:
            if not args.email:
                raise AdminSetupError("--email-only exige --email <adresse>.", code="invalid_email")
            if not deja_configure:
                raise AdminSetupError(
                    "Aucun compte administrateur à modifier : créez-le d'abord "
                    "(interface web, ou cette commande avec --email et un mot de passe).",
                    code="already_configured",
                )
            canonical = _validated_email(args.email)
            with db.session_scope() as session:
                cfg = RuntimeConfigService(session, secrets, settings)
                cfg.set_admin_identity(canonical, args.display_name)
            print(f"✓ Adresse de connexion mise à jour : {canonical}")
            return 0

        if args.email is None and not email_existant:
            # Sans adresse, le compte serait créé mais AUCUNE connexion ne pourrait
            # aboutir : le login compare (email, mot de passe) et refuse une adresse vide.
            raise AdminSetupError(
                "Adresse email requise à la création du compte (--email <adresse>).",
                code="invalid_email",
            )

        plaintext = _read_password()
        with db.session_scope() as session:
            cfg = RuntimeConfigService(session, secrets, settings)
            set_admin_password(
                cfg,
                plaintext,
                force=args.force,
                email=args.email,
                display_name=args.display_name,
            )
    except AdminSetupError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        if exc.code == "already_configured" and not args.force:
            print("  (utilisez --force pour remplacer le mot de passe existant)", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n✗ Annulé.", file=sys.stderr)
        return 130

    print(
        "✓ Compte administrateur enregistré (hash Argon2 chiffré au repos). "
        "Aucun mot de passe en clair n'est conservé. Les sessions ouvertes sont révoquées."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
