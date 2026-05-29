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
import socket
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


def _ip_is_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True si l'IP résolue doit être bloquée (privée/loopback/link-local/réservée…)."""
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def assert_resolved_ip_is_public(host: str, *, allow_local: bool = False) -> None:
    """Anti-SSRF AU RUNTIME (anti DNS rebinding) : résout `host` et vérifie CHAQUE IP.

    Contrairement à `validate_base_url` (purement lexicale, au point de configuration),
    cette fonction effectue la résolution DNS réelle juste avant l'appel sortant : un
    hostname public qui résout vers une IP interne (rebinding) est ainsi bloqué AVANT
    l'émission de la requête — donc avant toute fuite de token (clé LLM / token GLPI).

    `allow_local=True` (cas Ollama localhost) tolère les IP locales/privées.
    Lève `UrlSafetyError` si une IP résolue est interne (et non tolérée), ou si la
    résolution échoue (fail-closed).
    """
    if not host:
        return
    h = host.strip("[]").lower()
    # IP littérale : pas de DNS, on vérifie directement.
    try:
        literal = ipaddress.ip_address(h)
    except ValueError:
        literal = None
    if literal is not None:
        if _ip_is_blocked(literal) and not allow_local:
            raise UrlSafetyError(
                f"IP interne refusée (anti-SSRF) : {host}."
            )
        return

    if h in _LOCAL_HOSTNAMES:
        if not allow_local:
            raise UrlSafetyError(f"Hôte local refusé (anti-SSRF) : {host}.")
        return

    try:
        infos = socket.getaddrinfo(h, None)
    except OSError as exc:
        # Fail-closed : on ne laisse pas partir un appel vers un hôte non résolvable.
        raise UrlSafetyError(f"Résolution DNS impossible pour {host} (anti-SSRF).") from exc

    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split("%")[0])  # retire un éventuel scope IPv6
        except ValueError:
            continue
        if _ip_is_blocked(ip) and not allow_local:
            raise UrlSafetyError(
                f"L'hôte {host} résout vers une IP interne ({ip}) — bloqué (anti-SSRF / DNS rebinding)."
            )
