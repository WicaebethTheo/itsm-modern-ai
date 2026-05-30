"""Lien web (front GLPI) vers un ticket, dérivé de l'URL `apirest.php` configurée.

Pur (aucune dépendance) : réutilisable par le triage (journal) et le dashboard (anomalies).
"""

from __future__ import annotations


def ticket_web_link(glpi_base_url: str, ticket_id: int) -> str:
    """`…/front/ticket.form.php?id=<id>` à partir de l'URL API GLPI, sinon "" si non configurée.

    Dérive la racine web à partir de l'URL de l'API (legacy `apirest.php` ou nouvelle
    `api.php`, éventuellement versionnée `api.php/v1`). On TRONQUE à partir du marqueur —
    pas un simple suffixe — pour gérer aussi `…/api.php/v1` : sinon le lien pointerait sur
    l'API (`…/api.php/v1/front/…`) au lieu de l'UI web et GLPI renverrait une erreur API.
    """
    base = glpi_base_url.strip().rstrip("/")
    for marker in ("/apirest.php", "/api.php"):
        idx = base.find(marker)
        if idx != -1:
            base = base[:idx]
            break
    base = base.rstrip("/")
    return f"{base}/front/ticket.form.php?id={ticket_id}" if base else ""
