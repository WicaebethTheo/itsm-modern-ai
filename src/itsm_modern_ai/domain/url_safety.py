"""Validation anti-SSRF des URLs de base configurables (durcissement audit 2026-05).

Les URLs de base (GLPI, fournisseurs LLM) sont poussées via l'API/UI. La clé LLM part
en en-tête `Authorization` vers l'URL fournie : une URL attaquant (IP interne, loopback,
metadata cloud) provoquerait un SSRF + fuite de la clé. On valide donc :

- schéma `https://` exigé pour les URLs publiques ;
- `http://` toléré UNIQUEMENT pour un hôte local (localhost/loopback/lien-local), cas
  Ollama local ;
- hôtes/IP privés, loopback, lien-local, multicast, réservés → REJETÉS, SAUF si l'appel
  autorise explicitement le local (`allow_local=True`, p.ex. Ollama).

Module PUR (aucune I/O réseau ; pas de résolution DNS — la validation porte sur l'URL
littérale, ce qui suffit pour bloquer les saisies évidentes au point de configuration).
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

_LOCAL_HOSTNAMES = {"localhost", "ip6-localhost", "ip6-loopback"}


class UrlSafetyError(ValueError):
    """URL rejetée par la validation anti-SSRF."""


def _host_is_local_or_private(host: str) -> bool:
    """True si l'hôte est local/privé/non-routable (loopback, RFC1918, lien-local, ...)."""
    h = host.strip("[]").lower()  # enlève les crochets IPv6 littéraux
    if h in _LOCAL_HOSTNAMES:
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        # Nom d'hôte non-IP : on ne résout pas le DNS (module pur). Seul un nom
        # explicitement local est considéré local ; le reste est traité comme public.
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_base_url(url: str, *, allow_local: bool = False) -> str:
    """Valide une URL de base et la renvoie inchangée si sûre, sinon lève UrlSafetyError.

    `allow_local=True` autorise http:// et les hôtes locaux/privés (cas Ollama local).
    """
    if not url:
        return url
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise UrlSafetyError("URL invalide : schéma http(s) requis.")
    host = parsed.hostname
    if not host:
        raise UrlSafetyError("URL invalide : hôte manquant.")

    is_local = _host_is_local_or_private(host)

    if scheme == "http" and not (allow_local and is_local):
        raise UrlSafetyError(
            "http:// n'est toléré que pour un hôte local (Ollama). Utilisez https://."
        )
    if is_local and not allow_local:
        raise UrlSafetyError(
            "Hôte privé/loopback/non-routable refusé (anti-SSRF). "
            "Utilisez une URL publique en https://."
        )
    return url
