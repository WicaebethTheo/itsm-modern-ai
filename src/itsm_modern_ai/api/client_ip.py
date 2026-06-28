"""IP du client réelle — gestion du reverse proxy (X-Forwarded-For).

Derrière un proxy de confiance, `request.client.host` vaut l'IP du proxy ; toutes les
requêtes paraissent venir d'une seule IP → rate-limit login contournable. Si
`trust_proxy_headers=True`, on lit `X-Forwarded-For` pour retrouver l'IP du client.

⚠️ Sécurité : `X-Forwarded-For` est rempli de GAUCHE (client, **spoofable**) à DROITE
(chaque proxy de confiance, ex. nginx `$proxy_add_x_forwarded_for`, AJOUTE à droite l'IP
qu'il a vue). L'IP de confiance est donc la `trusted_hops`-ième en partant de la DROITE —
celle posée par NOTRE proxy. Prendre la valeur de gauche laisserait un client injecter de
fausses IP et contourner le rate-limit login FR-24 — précisément dans le déploiement
proxy pour lequel il est prévu. Défaut sûr : `trust_proxy_headers=False` (pilote/labo).
"""

from __future__ import annotations

from fastapi import Request


def client_ip(request: Request, trusted_proxies: bool, *, trusted_hops: int = 1) -> str:
    """Renvoie l'IP du client, en tenant compte du/des proxy(s) de confiance.

    - `trusted_proxies=False` → `request.client.host` (ou "unknown").
    - `trusted_proxies=True`  → la `trusted_hops`-ième valeur de `X-Forwarded-For` en
      partant de la DROITE (= l'IP vue par notre proxy ; les valeurs de gauche sont
      fournies par le client, donc spoofables). `trusted_hops` = nombre de proxys de
      confiance en amont (1 = un seul reverse proxy). Fallback `request.client.host`.

    Jamais d'exception ; header absent / vide / malformé → `request.client.host` ou "unknown".
    """
    fallback = request.client.host if request.client else "unknown"
    if not trusted_proxies:
        return fallback or "unknown"
    xff = request.headers.get("x-forwarded-for")
    if not xff:
        return fallback or "unknown"
    parts = [p.strip() for p in xff.split(",") if p.strip()]
    if not parts:
        return fallback or "unknown"
    hops = trusted_hops if trusted_hops >= 1 else 1
    idx = len(parts) - hops
    if idx < 0:
        idx = 0  # XFF plus court que la chaîne de proxys attendue → valeur connue la plus à gauche
    return parts[idx] or fallback or "unknown"
