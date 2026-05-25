"""Mock LLM déterministe — pour exécuter le spike/les tests SANS clé ni réseau.

⚠️ NON-REPRÉSENTATIF de la précision réelle d'un LLM. Sert uniquement à vérifier
la PLOMBERIE du pipeline (masquage → décision → whitelist → seuil → métriques)
hors-ligne. La vraie mesure de l'Epic 1 exige le vrai adaptateur + une clé Mistral.

Heuristique : matching par mots-clés vers une catégorie/technicien, confiance
modulée par le nombre de mots-clés trouvés. Volontairement imparfait pour que le
spike produise des cas « à trier » et des erreurs (sinon les métriques seraient factices).
"""

from __future__ import annotations

import re

from ...domain.models import Decision, Referentials
from ...ports.llm import LlmResult

# (mots-clés) -> (category_id, technician_id, priority)
_RULES: list[tuple[list[str], int, int, int]] = [
    (["mot de passe", "mdp", "compte", "connecter", "connexion", "ad", "certificat", "cadenas"], 1, 11, 3),
    (["paie", "rh", "congés", "conges", "bulletin", "erp", "sirh"], 2, 12, 3),
    (["pc", "ordi", "lent", "écran", "ecran", "clavier", "souris", "poste", "matériel", "materiel"], 3, 13, 2),
    (["mail", "messagerie", "outlook", "teams", "m365", "office", "boîte", "boite"], 4, 14, 3),
    (["réseau", "reseau", "wifi", "vpn", "lien", "virus", "phishing", "hamecon"], 5, 11, 4),
    (["imprimante", "impression", "scanner", "toner"], 6, 13, 2),
    (["téléphone", "telephone", "poste fixe", "voip"], 7, 13, 2),
]


def _score(text: str) -> tuple[int, int, int, float]:
    low = text.lower()
    best: tuple[int, int, int, int] | None = None  # (hits, cat, tech, prio)
    for keywords, cat, tech, prio in _RULES:
        hits = sum(1 for k in keywords if re.search(rf"\b{re.escape(k)}\b", low))
        if hits and (best is None or hits > best[0]):
            best = (hits, cat, tech, prio)
    if best is None:
        # Rien reconnu → décision faible (partira « à trier »).
        return 1, 11, 2, 0.35
    hits, cat, tech, prio = best
    confidence = min(0.95, 0.55 + 0.15 * hits)
    return cat, tech, prio, confidence


class MockLlm:
    """Implémente `LlmPort` de façon déterministe et hors-ligne."""

    def __init__(self, model: str = "mock-deterministic", refs: Referentials | None = None) -> None:
        self._model = model
        self._refs = refs

    async def complete(self, system_prompt: str, user_prompt: str) -> LlmResult:
        # Ne scorer QUE le contenu du ticket, pas les référentiels/fiches du prompt.
        ticket_text = user_prompt.rsplit("TICKET À TRIER", 1)[-1]
        cat, tech, prio, confidence = _score(ticket_text)
        decision = Decision(
            category=cat,
            priority=prio,
            technician_id=tech,
            draft="Bonjour, nous avons bien reçu votre demande et la prenons en charge.",
            confidence=confidence,
        )
        return LlmResult(
            decision=decision,
            model=self._model,
            prompt_tokens=len(user_prompt) // 4,
            completion_tokens=40,
            raw_response=decision.model_dump_json(),
        )
