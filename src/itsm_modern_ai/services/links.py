"""Lien web (front GLPI) vers un ticket, dérivé de l'URL `apirest.php` configurée.

Pur (aucune dépendance) : réutilisable par le triage (journal) et le dashboard (anomalies).
"""

from __future__ import annotations


def ticket_web_link(glpi_base_url: str, ticket_id: int) -> str:
    """`…/front/ticket.form.php?id=<id>` à partir de l'URL apirest, sinon "" si non configurée."""
    base = glpi_base_url.rstrip("/")
    for suffix in ("/apirest.php", "/api.php"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return f"{base}/front/ticket.form.php?id={ticket_id}" if base else ""
