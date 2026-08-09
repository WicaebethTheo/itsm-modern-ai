"""Absences et remplaçants — congés déclarés par l'admin (routage, FR-15).

Source de vérité LOCALE. GLPI expose un Planning, mais ce que son API en rend réellement
exploitable n'a pas été vérifié : promettre un import automatique sans l'avoir éprouvé
serait une promesse en l'air. Local d'abord ; import optionnel ensuite, si l'API tient.

Les trois pièges du sujet sont traités ICI, à la saisie, plutôt que découverts en production :
remplaçant non éligible, remplaçant lui-même absent, et bornes incohérentes.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlmodel import Session

from ...services import absences as absences_service
from ...services import referentials
from ..deps import get_session
from ..security import require_auth

router = APIRouter(prefix="/api", tags=["absences"], dependencies=[Depends(require_auth)])


class AbsenceItem(BaseModel):
    technician_ext_id: int
    start_date: date
    end_date: date
    replacement_ext_id: int | None = None
    note: str = Field(default="", max_length=500)


class AbsenceView(AbsenceItem):
    id: int
    technician_name: str = ""
    replacement_name: str = ""
    active: bool = False  # couvre la journée en cours (fuseau local configuré)


def _tz(request: Request, session: Session) -> str:
    from ...services.runtime_config import RuntimeConfigService

    settings = request.app.state.settings
    cfg = RuntimeConfigService(session, request.app.state.secrets_box, settings)
    return cfg.get("local_timezone") or settings.local_timezone


@router.get("/absences", response_model=list[AbsenceView])
def list_absences(request: Request, session: Session = Depends(get_session)) -> list[AbsenceView]:
    noms = {
        r.ext_id: r.name
        for r in referentials.list_kind(session, referentials.KIND_TECHNICIAN)
    }
    aujourdhui = absences_service.today_local(_tz(request, session))
    return [
        AbsenceView(
            id=a.id or 0,
            technician_ext_id=a.technician_ext_id,
            start_date=a.start_date,
            end_date=a.end_date,
            replacement_ext_id=a.replacement_ext_id,
            note=a.note,
            technician_name=noms.get(a.technician_ext_id, f"#{a.technician_ext_id}"),
            replacement_name=(
                noms.get(a.replacement_ext_id, f"#{a.replacement_ext_id}")
                if a.replacement_ext_id is not None
                else ""
            ),
            active=a.start_date <= aujourdhui <= a.end_date,
        )
        for a in absences_service.list_absences(session)
    ]


@router.put("/absences", response_model=list[AbsenceView])
def save_absences(
    request: Request,
    body: list[AbsenceItem],
    session: Session = Depends(get_session),
) -> list[AbsenceView]:
    """Remplace la liste des absences, après validation métier.

    Tout est refusé à la SAISIE plutôt qu'ignoré au runtime : une configuration
    silencieusement inopérante est le pire des deux mondes — l'admin croit avoir posé un
    filet, et découvre trois semaines plus tard qu'il n'a jamais existé.
    """
    _valide(session, body)
    absences_service.replace_all(session, [b.model_dump() for b in body])
    return list_absences(request, session)


MAX_ABSENCES = 2000  # borne défensive : la liste est remplacée en bloc par la console


def _valide(session: Session, body: list[AbsenceItem]) -> None:
    if len(body) > MAX_ABSENCES:
        _refus("too_many_absences", f"Trop d'absences ({len(body)} > {MAX_ABSENCES}).")
    eligibles = {
        r.ext_id
        for r in referentials.list_kind(session, referentials.KIND_TECHNICIAN)
        if r.eligible
    }
    for a in body:
        if a.end_date < a.start_date:
            _refus("invalid_period", f"Période invalide pour #{a.technician_ext_id} : la fin précède le début.")
        if a.replacement_ext_id is None:
            continue
        # PIÈGE 1 — remplaçant non éligible : le moteur ne route jamais vers lui, la
        # configuration serait sans effet.
        if a.replacement_ext_id not in eligibles:
            _refus(
                "replacement_not_eligible",
                f"Le remplaçant #{a.replacement_ext_id} n'est pas éligible : rendez-le "
                "éligible d'abord, sinon l'intérim resterait sans effet.",
            )
        if a.replacement_ext_id == a.technician_ext_id:
            _refus(
                "replacement_is_absent_actor",
                f"Le technicien #{a.technician_ext_id} ne peut pas se remplacer lui-même.",
            )
        # PIÈGE 2 — chaînes et cycles (A→B, B absent →C). On ne construit PAS de résolveur
        # de graphe : le comportement doit être compréhensible par un admin qui débarque,
        # pas mathématiquement complet. UN SEUL SAUT, et on refuse le cas qui le casserait.
        for autre in body:
            if (
                autre.technician_ext_id == a.replacement_ext_id
                and autre.start_date <= a.end_date
                and a.start_date <= autre.end_date
            ):
                _refus(
                    "replacement_also_absent",
                    f"Le remplaçant #{a.replacement_ext_id} est lui-même absent sur cette "
                    "période : choisissez quelqu'un de présent (l'intérim ne se chaîne pas).",
                )


def _refus(code: str, message: str) -> None:
    raise HTTPException(400, {"code": code, "message": message})
