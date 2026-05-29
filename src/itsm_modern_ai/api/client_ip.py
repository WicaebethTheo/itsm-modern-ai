"""IP du client réelle — gestion du reverse proxy (X-Forwarded-For).

Derrière un proxy de confiance, `request.client.host` vaut l'IP du proxy ; toutes
les requêtes paraissent venir d'une seule IP → rate-limit login contournable. Si
`trust_proxy_headers=True`, on lit la 1ʳᵉ valeur de `X-Forwarded-For` (= client
d'origine, RFC 7239). Défaut sûr : False (pas de proxy en pilote/labo).
"""

from __future__ import annotations

from fastapi import Request


def client_ip(request: Request, trusted_proxies: bool) -> str:
    """Renvoie l'IP du client, en tenant compte du proxy si demandé.

    - `trusted_proxies=False` → `request.client.host` (ou "unknown").
    - `trusted_proxies=True`  → 1ʳᵉ valeur de `X-Forwarded-For` si présente, sinon
      fallback sur `request.client.host`.

    Jamais d'exception ; valeur vide ou header malformé → "unknown".
    """
    fallback = request.client.host if request.client else "unknown"
    if not trusted_proxies:
        return fallback or "unknown"
    xff = request.headers.get("x-forwarded-for")
    if not xff:
        return fallback or "unknown"
    # XFF = "client, proxy1, proxy2" → on garde le client d'origine.
    first = xff.split(",", 1)[0].strip()
    return first or fallback or "unknown"
