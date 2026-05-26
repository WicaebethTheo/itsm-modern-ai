"""Chargement de Fiches techniciens depuis un YAML — SPIKE Epic 1 (homelab CLI) UNIQUEMENT.

Au runtime (prod), les fiches/éligibilités viennent du cache de référentiels édité
dans la console (cf. services/referentials.py). Ce module ne sert qu'au spike.
"""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel


class TechProfile(BaseModel):
    technician_id: int
    name: str = ""
    profile: str  # prose libre


class TechProfiles(BaseModel):
    profiles: list[TechProfile]

    def as_prose(self) -> str:
        blocks = []
        for p in self.profiles:
            header = f"Technicien {p.technician_id}" + (f" ({p.name})" if p.name else "")
            blocks.append(f"{header} :\n{p.profile.strip()}")
        return "\n\n".join(blocks)


def load_tech_profiles(path: str | Path) -> TechProfiles:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    items = raw.get("technicians", raw if isinstance(raw, list) else [])
    profiles = [
        TechProfile(
            technician_id=int(it["technician_id"]),
            name=str(it.get("name", "")),
            profile=str(it["profile"]),
        )
        for it in items
    ]
    return TechProfiles(profiles=profiles)
