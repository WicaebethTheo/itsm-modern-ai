#!/usr/bin/env python3
"""Diagnostic de connexion GLPI — à lancer à l'install pour dérisquer l'intégration.

Lit les identifiants depuis l'ENVIRONNEMENT (jamais en dur) :
    GLPI_BASE_URL  (ex. https://glpi.exemple.local/apirest.php)
    GLPI_USER_TOKEN
    GLPI_APP_TOKEN     (optionnel selon la config serveur)
    GLPI_VERIFY_TLS=false   (optionnel, certificat auto-signé)

Lecture seule par défaut. `--write-test <ticket_id>` teste l'écriture d'un Suivi
PRIVÉ (puis l'efface) pour valider FR-4 — à n'utiliser que sur un ticket de test.

    GLPI_BASE_URL=… GLPI_USER_TOKEN=… GLPI_APP_TOKEN=… \
        uv run python scripts/glpi_diagnose.py [--write-test 181]
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from itsm_modern_ai.adapters.itsm.glpi.connector import GlpiConnector  # noqa: E402
from itsm_modern_ai.config.credentials import GlpiCredentials  # noqa: E402
from itsm_modern_ai.domain.errors import ItsmError  # noqa: E402


def _creds() -> GlpiCredentials:
    base = os.environ.get("GLPI_BASE_URL")
    user = os.environ.get("GLPI_USER_TOKEN")
    if not base or not user:
        sys.exit("ERREUR : définir GLPI_BASE_URL et GLPI_USER_TOKEN dans l'environnement.")
    return GlpiCredentials(
        base_url=base,
        user_token=user,
        app_token=os.environ.get("GLPI_APP_TOKEN", ""),
        verify_tls=os.environ.get("GLPI_VERIFY_TLS", "true").lower() not in ("0", "false", "no"),
        timeout_seconds=30.0,
        followup_legacy_9x=os.environ.get("GLPI_FOLLOWUP_LEGACY_9X", "false").lower()
        in ("1", "true", "yes"),
    )


async def run(args: argparse.Namespace) -> int:
    c = GlpiConnector(_creds())
    try:
        if not await c.healthcheck():
            print("❌ healthcheck KO (auth/URL/SSL ?)")
            return 1
        print("✅ healthcheck OK")

        refs = await c.get_referentials()
        print(
            f"✅ référentiels : {len(refs.categories)} catégories · {len(refs.technicians)} "
            f"techniciens · {len(refs.groups)} groupes · {len(refs.entities)} entités "
            f"· {len(refs.technician_profiles)} profils"
        )

        news = await c.get_new_tickets()
        print(f"✅ tickets « New » : {len(news)}")

        since = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=14)
        stats = await c.get_recent_tickets(since)
        with_ttr = sum(1 for s in stats if s.time_to_resolve is not None)
        print(f"✅ tickets récents (14 j) : {len(stats)} (dont {with_ttr} avec SLA TTR)")

        if args.write_test:
            fid = await c.write_followup(
                args.write_test, "[TEST diagnostic ITSM Modern AI] Suivi privé — à ignorer.", private=True
            )
            print(f"✅ write_followup OK sur le ticket #{args.write_test} → suivi #{fid} (pensez à le retirer)")
    except ItsmError as exc:
        print(f"❌ erreur GLPI typée : {exc}")
        return 1
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Diagnostic de connexion GLPI (lecture seule par défaut).")
    p.add_argument("--write-test", type=int, metavar="TICKET_ID", help="teste l'écriture d'un Suivi privé")
    return asyncio.run(run(p.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
