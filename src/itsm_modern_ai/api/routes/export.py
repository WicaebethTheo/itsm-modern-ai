"""Export CSV pour la DPO (FR-21). Aucune métrique nominative produite."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from sqlmodel import Session

from ...persistence import journal
from ..deps import get_session
from ..security import require_auth

router = APIRouter(prefix="/api/export", tags=["export"], dependencies=[Depends(require_auth)])


def _csv_response(text: str, filename: str) -> PlainTextResponse:
    return PlainTextResponse(
        text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/decisions.csv")
def export_decisions(session: Session = Depends(get_session)) -> PlainTextResponse:
    return _csv_response(journal.decisions_csv(session), "decisions.csv")


@router.get("/llm-calls.csv")
def export_llm_calls(session: Session = Depends(get_session)) -> PlainTextResponse:
    return _csv_response(journal.llm_calls_csv(session), "llm-calls.csv")
