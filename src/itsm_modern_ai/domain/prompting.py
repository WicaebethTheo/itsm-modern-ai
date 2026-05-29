"""Construction du prompt de triage (pur, sans I/O).

Fournit au LLM : le Ticket MASQUÉ, le périmètre AUTORISÉ (catégories, techniciens
et groupes éligibles) et leurs fiches en prose (FR-15). Demande une Décision en
JSON strict (FR-6). Le LLM ne décide jamais seul : le code valide ensuite chaque
ID contre la Whitelist effective (FR-7).
"""

from __future__ import annotations

from .models import Referentials

# NB : le prompt demande "JAMAIS null" pour category, mais le schéma Decision accepte null
# au cas où le LLM ignore la consigne (Sonnet 4.6+ le fait parfois). Dans ce cas, la whitelist
# rejette en « à trier » via CATEGORY_NOT_IN_WHITELIST. Voir Decision.category dans models.py.
SYSTEM_PROMPT = (
    "Tu es un assistant de triage de tickets de support informatique pour une PME "
    "française utilisant GLPI. Tu proposes un classement ; tu ne décides jamais seul. "
    "Tu réponds UNIQUEMENT par un objet JSON valide, sans texte autour, avec EXACTEMENT "
    "ces clés : category (int), priority (int), technician_id (int ou null), "
    "group_id (int ou null), draft (string), confidence (float entre 0 et 1).\n"
    "- category : choisis un ID dans la liste des catégories AUTORISÉES. "
    "**JAMAIS null**. Si tu hésites, choisis la moins inadaptée et baisse `confidence` — "
    "le garde-fou côté code triera vers « à trier » sur faible confiance ; ce n'est PAS à toi "
    "d'exprimer le doute par un null sur category.\n"
    "- priority : 1=Très basse, 2=Basse, 3=Moyenne, 4=Haute, 5=Très haute, 6=Majeure. "
    "**Entier obligatoire**, jamais null.\n"
    "- technician_id : l'ID du technicien éligible le plus pertinent d'après les fiches, "
    "ou null si aucun ne convient.\n"
    "- group_id : si aucun technicien précis ne convient, l'ID d'un groupe éligible "
    "(fallback), sinon null. Préfère TOUJOURS un technicien à un groupe quand c'est possible.\n"
    "- draft : un brouillon de première réponse au demandeur, en français, courtois et concis.\n"
    "- confidence : ton degré de certitude honnête (0.0 à 1.0). Sois bas si le ticket est ambigu, "
    "hors périmètre, ou si aucune catégorie/assignation ne convient vraiment."
)


def _block(title: str, items: dict[int, str]) -> str:
    if not items:
        return f"{title} : (aucun)"
    lines = "\n".join(f"  - {i}: {name}" for i, name in sorted(items.items()))
    return f"{title} :\n{lines}"


def _format_referentials(refs: Referentials) -> str:
    parts = [
        _block("Catégories autorisées (id: nom)", refs.categories),
        _block("Priorités (id: nom)", refs.priorities),
        _block("Techniciens éligibles (id: nom)", refs.technicians),
        _block("Groupes éligibles (id: nom)", refs.groups),
    ]
    return "\n\n".join(parts)


def build_guidance(
    *, response_tone: str = "", assistant_name: str = "", routing_rules: str = ""
) -> str:
    """Consignes paramétrées par l'admin (données injectées, jamais des ordres système)."""
    parts: list[str] = []
    if response_tone.strip():
        parts.append(f"- Ton du brouillon : {response_tone.strip()}.")
    if assistant_name.strip():
        parts.append(f"- Signe le brouillon au nom de : {assistant_name.strip()}.")
    if routing_rules.strip():
        parts.append(f"- Consignes de routage de l'organisation :\n{routing_rules.strip()}")
    return "\n".join(parts)


def build_user_prompt(
    masked_content: str, refs: Referentials, profiles_prose: str, guidance: str = ""
) -> str:
    """Assemble le message utilisateur. `masked_content` DOIT déjà être masqué."""
    prose = profiles_prose.strip() or "(aucune fiche fournie)"
    guidance_block = (
        f"Consignes (paramétrées par l'admin) :\n{guidance.strip()}\n\n" if guidance.strip() else ""
    )
    return (
        f"{_format_referentials(refs)}\n\n"
        f"Fiches techniciens et groupes (prose libre) :\n{prose}\n\n"
        f"{guidance_block}"
        f"--- TICKET À TRIER (contenu déjà masqué) ---\n{masked_content}\n\n"
        "Renvoie uniquement le JSON de la Décision."
    )
