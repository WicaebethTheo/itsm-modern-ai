"""Statut runtime du moteur (FR-27, observabilité minimale)."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["status"])


class Status(BaseModel):
    polling_enabled: bool
    polling_interval_seconds: int
    whitelist_loaded: bool
    categories_count: int
    technicians_count: int


@router.get("/status", response_model=Status)
def status(request: Request) -> Status:
    settings = request.app.state.settings
    cache = request.app.state.whitelist_cache
    refs = cache.referentials
    return Status(
        polling_enabled=settings.polling_enabled,
        polling_interval_seconds=settings.polling_interval_seconds,
        whitelist_loaded=cache.is_loaded,
        categories_count=len(refs.categories),
        technicians_count=len(refs.technicians),
    )
