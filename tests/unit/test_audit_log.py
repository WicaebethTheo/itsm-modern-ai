"""Journal d'audit des actions d'administration (durcissement audit 2026-08).

Défaut prouvé : `grep logger.` sur les routes de configuration renvoyait ZÉRO. Basculer une
entité en `full_auto` (l'IA répond publiquement au demandeur), couper le masquage PII,
mettre la rétention RGPD à 0 ou retirer la licence ne laissaient AUCUNE trace — et la purge
RGPD effaçait la seule table qui aurait pu en témoigner.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from sqlmodel import Session, select

from itsm_modern_ai.adapters.secrets.encrypted import FernetSecretsBox
from itsm_modern_ai.config.settings import Settings
from itsm_modern_ai.persistence import db
from itsm_modern_ai.persistence.tables import AuditLog
from itsm_modern_ai.services.runtime_config import RuntimeConfigService


@pytest.fixture
def cfg(tmp_path) -> RuntimeConfigService:
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'audit.db'}",
        master_key=Fernet.generate_key().decode(),
    )
    db._engine = None
    db.init_engine(settings.database_url)
    db.create_all()
    box = FernetSecretsBox(master_key=settings.master_key, key_file=tmp_path / "master.key")
    yield RuntimeConfigService(Session(db.get_engine()), box, settings, actor="10.0.0.7")
    db._engine = None


def _rows(cfg: RuntimeConfigService) -> list[AuditLog]:
    with db.session_scope() as s:
        return list(s.exec(select(AuditLog).order_by(AuditLog.id)))


def test_plain_change_is_recorded_with_old_and_new_value(cfg):
    """Le cas emblématique : passer le moteur en `full_auto` doit laisser une trace."""
    cfg.set("execution_mode_default", "full_auto")
    rows = _rows(cfg)
    assert len(rows) == 1
    row = rows[0]
    assert row.action == "config.set"
    assert row.key == "execution_mode_default"
    assert row.old_value == "suggestion"  # valeur EFFECTIVE avant changement (défaut env)
    assert row.new_value == "full_auto"
    assert row.actor == "10.0.0.7"
    assert row.ts.tzinfo is not None  # horodatage tz-aware, comme les autres tables


def test_retention_to_zero_is_recorded(cfg):
    """Mettre la rétention RGPD à 0 (donc tout garder/tout casser) doit être imputable."""
    cfg.set("retention_decisions_days", "0")
    assert [(r.key, r.new_value) for r in _rows(cfg)] == [("retention_decisions_days", "0")]


def test_secret_value_is_never_stored_in_audit(cfg):
    """Un secret ne doit JAMAIS être recopié : l'audit ne devient pas un second coffre."""
    cfg.set_secret("llm_api_key", "sk-super-secret-123")
    row = _rows(cfg)[0]
    assert row.action == "config.set_secret" and row.key == "llm_api_key"
    assert row.old_value == "" and row.new_value == "***"  # posé alors qu'il n'existait pas
    # Aucune trace du clair, où que ce soit dans la ligne.
    assert "sk-super-secret-123" not in f"{row.old_value}{row.new_value}{row.key}{row.actor}"

    # Effacement du secret : la transition « défini → effacé » reste lisible.
    cfg.set_secret("llm_api_key", "")
    cleared = _rows(cfg)[1]
    assert cleared.old_value == "***" and cleared.new_value == ""


def test_license_key_is_masked_even_though_not_a_secret(cfg):
    """`license_key` n'est pas chiffrée mais reste un jeton exploitable → masquée."""
    from itsm_modern_ai.services.runtime_config import CLEARED_SENTINEL

    cfg.set("license_key", "eyJhbGciOiJFZDI1NTE5In0.charge-utile")
    posee = _rows(cfg)[0]
    assert posee.new_value == "***" and "eyJ" not in posee.new_value

    cfg.set("license_key", CLEARED_SENTINEL)  # retrait de licence (re-verrouillage)
    retiree = _rows(cfg)[1]
    assert retiree.old_value == "***" and retiree.new_value == ""


def test_by_parameter_overrides_default_actor(cfg):
    """`by=` (même convention que `retention.record_last_run`) prime sur l'acteur du service."""
    cfg.set("polling_enabled", "false", by="scheduler")
    assert _rows(cfg)[0].actor == "scheduler"


def test_machine_state_writes_are_not_audited(cfg):
    """L'état du dernier cycle/purge est de la télémétrie : l'auditer noierait le signal."""
    cfg.set("poll_last_run_at", "2026-08-08T10:00:00+00:00")
    cfg.set("automation_purge_last_decisions_deleted", "12")
    assert _rows(cfg) == []
    # …mais un vrai réglage écrit juste après est bien tracé (l'exclusion est ciblée).
    cfg.set("automation_purge_enabled", "false")
    assert [r.key for r in _rows(cfg)] == ["automation_purge_enabled"]


def test_long_values_are_bounded(cfg):
    """Un `system_prompt` de 8000 caractères ne doit pas être archivé à chaque frappe."""
    from itsm_modern_ai.services.runtime_config import AUDIT_VALUE_MAX_CHARS

    cfg.set("system_prompt", "x" * 8000)
    assert len(_rows(cfg)[0].new_value) == AUDIT_VALUE_MAX_CHARS


def test_audit_is_not_touched_by_rgpd_purge(cfg):
    """Arbitrage assumé : l'audit est une donnée d'IMPUTABILITÉ, pas une donnée de ticket.

    La purger sur la fenêtre « tickets » offrirait un effacement de traces trivial :
    `retention_decisions_days=1` — action justement auditée — suffirait à la faire
    disparaître.
    """
    from datetime import UTC, datetime, timedelta

    from itsm_modern_ai.services import retention

    cfg.set("execution_mode_default", "full_auto")
    with db.session_scope() as s:
        result = retention.purge_now(
            s,
            decisions_days=1,
            llm_calls_days=1,
            now=datetime.now(UTC) + timedelta(days=3650),
        )
    assert result.decisions_deleted == 0
    assert len(_rows(cfg)) == 1  # la trace survit à la purge
