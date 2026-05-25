"""Construction du prompt de triage (pur, sans I/O).

Fournit au LLM : le Ticket MASQUÉ, les listes fermées (Whitelist) et les Fiches
techniciens en prose (FR-15). Demande une Décision en JSON strict (FR-6).
Le LLM ne voit JAMAIS d'ID hors Whitelist comme valide — mais c'est le code qui
tranche (FR-7), pas le prompt.
"""

from __future__ import annotations

from .models import Referentials

SYSTEM_PROMPT = (
    "Tu es un assistant de triage de tickets de support informatique pour une PME "
    "française utilisant GLPI. Tu proposes un classement ; tu ne décides jamais seul. "
    "Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour, avec EXACTEMENT "
    "ces clés : category (int), priority (int), technician_id (int), draft (string), "
    "confidence (float entre 0 et 1).\n"
    "- category : choisis l'ID dans la liste fournie.\n"
    "- priority : 1=Très basse, 2=Basse, 3=Moyenne, 4=Haute, 5=Très haute, 6=Majeure.\n"
    "- technician_id : choisis l'ID du technicien le plus pertinent d'après les fiches.\n"
    "- draft : un brouillon de première réponse au demandeur, en français, courtois et concis.\n"
    "- confidence : ton degré de certitude honnête. Sois bas si le ticket est ambigu, "
    "hors périmètre, ou si aucune catégorie/technicien ne convient vraiment."
)


def _format_referentials(refs: Referentials) -> str:
    cats = "\n".join(f"  - {cid}: {name}" for cid, name in sorted(refs.categories.items()))
    prios = "\n".join(f"  - {pid}: {name}" for pid, name in sorted(refs.priorities.items()))
    techs = "\n".join(f"  - {tid}: {name}" for tid, name in sorted(refs.technicians.items()))
    return (
        f"Catégories autorisées (id: nom) :\n{cats}\n\n"
        f"Priorités (id: nom) :\n{prios}\n\n"
        f"Techniciens autorisés (id: nom) :\n{techs}"
    )


def build_user_prompt(masked_content: str, refs: Referentials, tech_profiles_prose: str) -> str:
    """Assemble le message utilisateur. `masked_content` DOIT déjà être masqué."""
    return (
        f"{_format_referentials(refs)}\n\n"
        f"Fiches techniciens (prose libre) :\n{tech_profiles_prose}\n\n"
        f"--- TICKET À TRIER (contenu déjà masqué) ---\n{masked_content}\n\n"
        "Renvoie uniquement le JSON de la Décision."
    )
