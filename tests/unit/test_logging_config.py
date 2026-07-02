"""Configuration logging centralisée (observabilité — durcissement audit 2026-05)."""

from __future__ import annotations

import json
import logging

from itsm_modern_ai.config.logging import JsonFormatter, configure_logging


def test_configure_text_sets_root_level():
    configure_logging(level="WARNING", fmt="text")
    assert logging.getLogger().level == logging.WARNING


def test_invalid_level_falls_back_to_info():
    configure_logging(level="NOPE", fmt="text")
    assert logging.getLogger().level == logging.INFO


def test_json_formatter_emits_valid_json_without_pii_leak():
    rec = logging.LogRecord(
        name="itsm.app", level=logging.INFO, pathname=__file__, lineno=1,
        msg="poll cycle %d", args=(3,), exc_info=None,
    )
    out = JsonFormatter().format(rec)
    payload = json.loads(out)
    assert payload["level"] == "INFO"
    assert payload["logger"] == "itsm.app"
    assert payload["msg"] == "poll cycle 3"
    assert "ts" in payload


def test_json_formatter_includes_extra_fields():
    rec = logging.LogRecord(
        name="itsm.app", level=logging.INFO, pathname=__file__, lineno=1,
        msg="done", args=(), exc_info=None,
    )
    rec.duration_s = 1.5
    payload = json.loads(JsonFormatter().format(rec))
    assert payload["duration_s"] == 1.5
