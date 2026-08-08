"""Export CSV pour la DPO (FR-21). Aucune métrique nominative produite."""

from __future__ import annotations

from collections.abc import Callable, Iterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from ...persistence import db, journal
from ..security import require_auth

router = APIRouter(prefix="/api/export", tags=["export"], dependencies=[Depends(require_auth)])


def _csv_response(
    producteur: Callable[[Session], Iterator[str]], filename: str
) -> StreamingResponse:
    """Sert un export CSV EN FLUX (aucune accumulation du fichier en mémoire).

    L'export des appels LLM porte prompts et réponses brutes : construit d'un bloc, il
    coûtait ~270 Mo de pic pour 71 Mo de fichier (20 000 appels mesurés) — largement de quoi
    faire tomber un conteneur limité à 512 Mo, avec un redémarrage qui ressemble à un
    plantage aléatoire côté utilisateur. On rend donc le CSV par tranches.

    La session est ouverte DANS le générateur, et non par la dépendance `get_session` : le
    corps d'une `StreamingResponse` est consommé APRÈS la sortie des dépendances FastAPI —
    la session serait déjà refermée quand le curseur se met à défiler.
    """

    def _flux() -> Iterator[str]:
        with db.session_scope() as session:
            yield from producteur(session)

    return StreamingResponse(
        _flux(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/decisions.csv")
def export_decisions() -> StreamingResponse:
    return _csv_response(journal.decisions_csv_stream, "decisions.csv")


@router.get("/llm-calls.csv")
def export_llm_calls() -> StreamingResponse:
    return _csv_response(journal.llm_calls_csv_stream, "llm-calls.csv")
