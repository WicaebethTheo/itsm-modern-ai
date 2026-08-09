"""Contrats d'EXPLOITATION des fichiers de déploiement (composes, Dockerfile, scripts).

Ces fichiers ne sont couverts par aucun test d'intégration : on ne construit pas d'image
en CI unitaire. Or leurs régressions sont exactement celles qui réveillent un DSI à 2 h
du matin (sauvegarde inutilisable, disque plein, conteneur `unhealthy` à cause d'un
fournisseur tiers, aucune sortie de secours). On verrouille donc ici les invariants.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
COMPOSES = ("docker-compose.yml", "docker-compose.portainer.yml")


def _service(name: str) -> dict:
    return yaml.safe_load((ROOT / name).read_text(encoding="utf-8"))["services"]["itsm"]


@pytest.mark.parametrize("compose", COMPOSES)
def test_healthcheck_never_depends_on_glpi_or_llm(compose):
    """La sonde du conteneur doit rester une sonde de VIVACITÉ.

    `/health?probe=true` toutes les 30 s = ~2 880 sessions GLPI + 2 880 appels LLM par
    jour, et un incident chez le fournisseur marque `unhealthy` un moteur SAIN : sous
    Swarm/k8s/autoheal, c'est un redémarrage en boucle causé par un tiers.
    """
    probe = " ".join(_service(compose)["healthcheck"]["test"])
    assert "/health/live" in probe
    assert "probe=true" not in probe


def test_dockerfile_healthcheck_is_liveness_only():
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    healthcheck = dockerfile.split("HEALTHCHECK", 1)[1]
    assert "/health/live" in healthcheck


@pytest.mark.parametrize("compose", COMPOSES)
def test_logs_are_rotated(compose):
    """Sans rotation, json-file remplit le disque en quelques mois — et un disque plein
    empêche d'écrire en base, donc de comptabiliser le plafond de coût LLM."""
    options = _service(compose)["logging"]["options"]
    assert options["max-size"] and options["max-file"]


@pytest.mark.parametrize("compose", COMPOSES)
def test_resources_are_bounded(compose):
    limits = _service(compose)["deploy"]["resources"]["limits"]
    assert limits["cpus"] and limits["memory"]


def test_la_sauvegarde_est_livree_DANS_le_paquet():
    """L'invariant qui compte pour un exploitant : pouvoir sauvegarder **sans les sources**.

    La voie recommandée est *pull-only* (image GHCR, Portainer, `docker run`, one-liner) :
    tant que la logique ne vivait que dans le `Makefile`, quiconque suivait la documentation
    n'avait AUCUN moyen de sauvegarder — sur un volume contenant les données RGPD ET la
    `master.key` sans laquelle la base est définitivement illisible.
    """
    module = ROOT / "src" / "itsm_modern_ai" / "backup.py"
    assert module.is_file(), "la sauvegarde doit être livrée dans l'image, pas dans le Makefile"
    code = module.read_text(encoding="utf-8")
    assert "VACUUM INTO" in code  # copie cohérente, WAL inclus
    assert "integrity_check" in code  # … et VÉRIFIÉE
    assert "master.key" in code  # sans elle, la base restaurée est illisible


def test_le_makefile_delegue_au_paquet_sans_dupliquer():
    """Deux implémentations de la sauvegarde divergeraient — et c'est celle de l'exploitant,
    la moins testée, qui casserait. La cible Make n'est qu'un raccourci."""
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    backup = makefile.split("\nbackup:", 1)[1].split("\nlint:", 1)[0]
    assert "itsm_modern_ai.backup" in backup
    assert "cp -a data/itsm.db " not in backup  # la copie à chaud du seul .db reste bannie
    assert "|| true" not in backup  # un échec de sauvegarde doit être BRUYANT


def test_installer_offers_a_rollback_path():
    """docs/install.md promet « le script affiche la procédure de rollback » : sans
    `--rollback`, revenir à l'image précédente sans restaurer la base fait boucler
    l'entrypoint sur `Can't locate revision identified by …`."""
    installer = (ROOT / "install.sh").read_text(encoding="utf-8")
    assert "--rollback" in installer
    assert "--list-backups" in installer
    # Une mise à jour ratée ne doit JAMAIS laisser l'instance à l'arrêt (backup_data
    # arrête le conteneur AVANT le build, qui peut échouer).
    assert "trap restore_service_on_failure EXIT" in installer


@pytest.mark.parametrize("script", ["install.sh", "docker/entrypoint.sh"])
def test_shell_scripts_parse(script):
    assert subprocess.run(["bash", "-n", str(ROOT / script)], check=False).returncode == 0
