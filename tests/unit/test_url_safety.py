"""Validation anti-SSRF des URLs de base (module pur domain/url_safety.py)."""

from __future__ import annotations

import pytest

from itsm_modern_ai.domain.url_safety import UrlSafetyError, validate_base_url


@pytest.mark.parametrize(
    "url",
    [
        "https://api.mistral.ai/v1",
        "https://glpi.exemple.local/apirest.php",
        "https://api.openai.com/v1",
    ],
)
def test_public_https_accepted(url):
    assert validate_base_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/v1",
        "https://localhost/v1",
        "https://10.0.0.5/v1",
        "https://192.168.1.10/v1",
        "https://169.254.169.254",  # metadata cloud
        "http://api.mistral.ai/v1",  # http public refusé
        "ftp://example.com",  # schéma non http
    ],
)
def test_dangerous_urls_rejected(url):
    with pytest.raises(UrlSafetyError):
        validate_base_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:11434/v1",
        "http://127.0.0.1:11434/v1",
        "https://192.168.1.50:11434/v1",
    ],
)
def test_ollama_local_allowed_when_allow_local(url):
    assert validate_base_url(url, allow_local=True) == url


def test_empty_url_passes_through():
    assert validate_base_url("") == ""
