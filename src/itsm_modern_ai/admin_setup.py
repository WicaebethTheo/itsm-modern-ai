"""Amorçage / rotation du compte administrateur (FR-24).

Stocke le mot de passe admin **directement en base** sous forme de hash Argon2 chiffré
Fernet — **aucun mot de passe en clair** n'est conservé (ni `.env`, ni log, ni historique
shell). Remplace l'amorçage par `ADMIN_PASSWORD` (qui reste un fallback optionnel pour les
déploiements non-interactifs).

Usage (typiquement via `install.sh` ou `docker compose exec`) :
    python -m itsm_modern_ai.admin_setup            # prompt masqué + confirmation
    python -m itsm_modern_ai.admin_setup --force    # remplace un mot de passe existant
    python -m itsm_modern_ai.admin_setup --check     # 0 si déjà configuré, 1 sinon

Source du mot de passe, par ordre de priorité :
  1. variable d'env ITSM_ADMIN_PASSWORD (non-interactif / CI) ;
  2. stdin si l'entrée est un pipe ;
  3. saisie masquée interactive (getpass) + confirmation.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys

from .adapters.secrets.encrypted import FernetSecretsBox
from .api.security import HASH_KEY, hash_password
from .config.settings import get_settings
from .persistence import db
from .services.runtime_config import RuntimeConfigService

MIN_LEN = 8


class AdminSetupError(Exception):
    """Erreur fonctionnelle d'amorçage (message clair, pas de stack)."""


def set_admin_password(cfg: RuntimeConfigService, plaintext: str, *, force: bool = False) -> None:
    """Valide puis stocke le hash du mot de passe admin. Idempotence contrôlée par `force`."""
    if len(plaintext) < MIN_LEN:
        raise AdminSetupError(f"Mot de passe trop court (minimum {MIN_LEN} caractères).")
    if cfg.is_secret_set(HASH_KEY) and not force:
        raise AdminSetupError(
            "Un mot de passe administrateur est déjà configuré. "
            "Utilisez --force pour le remplacer."
        )
    cfg.set_secret(HASH_KEY, hash_password(plaintext))


def _read_password() -> str:
    env = os.environ.get("ITSM_ADMIN_PASSWORD")
    if env:
        return env
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="itsm_modern_ai.admin_setup",
        description="Définit le mot de passe administrateur (hash Argon2 chiffré en base).",
    )
    parser.add_argument("--force", action="store_true", help="Remplace un mot de passe existant.")
    parser.add_argument(
        "--check", action="store_true", help="N'écrit rien : sort 0 si déjà configuré, 1 sinon."
    )
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
        plaintext = _read_password()
        with db.session_scope() as session:
            cfg = RuntimeConfigService(session, secrets, settings)
            set_admin_password(cfg, plaintext, force=args.force)
    except AdminSetupError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n✗ Annulé.", file=sys.stderr)
        return 130

    print(
        "✓ Mot de passe administrateur enregistré (hash Argon2 chiffré au repos). "
        "Aucun mot de passe en clair n'est conservé."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
