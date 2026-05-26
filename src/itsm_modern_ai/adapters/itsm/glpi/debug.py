"""Outils de DEBUG GLPI (labo/test uniquement) : jeux de données + purge.

⚠️ Contient des actions DESTRUCTIVES. À n'utiliser qu'en environnement de test, derrière
le flag `debug_tools_enabled` et l'authentification. La purge fait un SOFT-delete GLPI
(corbeille, récupérable) et protège les comptes système / `glpi` / l'utilisateur du token.
"""

from __future__ import annotations

import uuid

import httpx

from ....config.credentials import GlpiCredentials
from .client import GlpiClient

# Comptes jamais supprimés : système (1) + super-admin glpi (2 par défaut).
PROTECTED_IDS = {1, 2}
PROTECTED_NAMES = {"glpi"}


def _new_id(resp: httpx.Response) -> int:
    body = resp.json()
    if isinstance(body, list):
        body = body[0] if body else {}
    return int(body["id"])


class GlpiDebugOps:
    def __init__(self, creds: GlpiCredentials, *, http_client: httpx.AsyncClient | None = None) -> None:
        self._creds = creds
        self._http = http_client

    def _client(self) -> GlpiClient:
        return GlpiClient(
            base_url=self._creds.base_url,
            user_token=self._creds.user_token,
            app_token=self._creds.app_token,
            verify_tls=self._creds.verify_tls,
            timeout=self._creds.timeout_seconds,
            client=self._http,
        )

    async def seed(self, technicians: int = 3, groups: int = 2) -> dict:
        """Crée de faux techniciens (+ profil Technician) et groupes assignables."""
        created_users: list[int] = []
        created_groups: list[int] = []
        async with self._client() as gc:
            profiles = (await gc.get("Profile", params={"range": "0-999"})).json()
            tech_pid = next(
                (int(p["id"]) for p in profiles if str(p.get("name", "")).lower() == "technician"),
                None,
            )
            for _ in range(max(0, technicians)):
                tag = uuid.uuid4().hex[:6]
                uid = _new_id(
                    await gc.post(
                        "User",
                        json={"input": {"name": f"demo_tech_{tag}", "realname": "Démo",
                                        "firstname": f"Tech {tag}", "is_active": 1}},
                    )
                )
                created_users.append(uid)
                if tech_pid is not None:
                    await gc.post(
                        "Profile_User",
                        json={"input": {"users_id": uid, "profiles_id": tech_pid, "entities_id": 0}},
                    )
            for _ in range(max(0, groups)):
                tag = uuid.uuid4().hex[:6]
                gid = _new_id(
                    await gc.post(
                        "Group",
                        json={"input": {"name": f"Démo Groupe {tag}", "is_assign": 1, "entities_id": 0}},
                    )
                )
                created_groups.append(gid)
        return {"users": created_users, "groups": created_groups}

    async def purge_users(self) -> dict:
        """SOFT-delete tous les utilisateurs sauf protégés (système, glpi, user du token)."""
        async with self._client() as gc:
            session = (await gc.get("getFullSession")).json()
            current_uid = int((session.get("session") or {}).get("glpiID") or 0)
            users = (await gc.get("User", params={"range": "0-9999"})).json()
            if isinstance(users, dict):
                users = [users]

            deleted, kept = 0, 0
            for u in users:
                uid = int(u["id"])
                name = str(u.get("name", "")).lower()
                already_deleted = str(u.get("is_deleted") or "0") not in ("0", "False", "false", "")
                if uid in PROTECTED_IDS or uid == current_uid or name in PROTECTED_NAMES or already_deleted:
                    kept += 1
                    continue
                await gc.delete(f"User/{uid}", json={"input": {"id": uid}})
                deleted += 1
        return {"deleted": deleted, "kept": kept, "protected_user_id": current_uid}
