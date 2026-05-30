"""Configuration centralisée du logging (logging.config.dictConfig).

Appelée une seule fois au démarrage (create_app). Deux formats :
- `text`  : lisible en dev (timestamp, niveau, logger, message).
- `json`  : 1 ligne = 1 objet JSON pour l'agrégation (Loki/ELK).

⚠️ AUCUNE PII n'est journalisée par ce format : on n'émet que les champs
structurels du LogRecord (niveau, logger, message déjà composé par le code
appelant). Le contenu des messages reste de la responsabilité des modules ;
les routes/connecteurs n'y mettent pas de corps de requête ni de secrets.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import logging.config

# Niveaux acceptés (sécurise une valeur d'env libre vers un défaut sûr).
_VALID_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}

# Attributs standards d'un LogRecord — tout le reste (passé via `extra=`) est
# considéré comme champ métier et ajouté au JSON.
_RESERVED = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "taskName",
}


class JsonFormatter(logging.Formatter):
    """Formate un LogRecord en une ligne JSON (sans PII implicite)."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": _dt.datetime.fromtimestamp(record.created, tz=_dt.UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        # Champs métier explicitement passés via `logger.info(..., extra={...})`.
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str = "INFO", fmt: str = "text") -> None:
    """Installe la config logging racine. Idempotent (rejouable sans dupliquer)."""
    level = (level or "INFO").upper()
    if level not in _VALID_LEVELS:
        level = "INFO"
    fmt = (fmt or "text").lower()
    if fmt not in {"text", "json"}:
        fmt = "text"

    formatter: dict[str, object]
    if fmt == "json":
        formatter = {"()": "itsm_modern_ai.config.logging.JsonFormatter"}
    else:
        formatter = {
            "format": "%(asctime)s %(levelname)-8s %(name)s: %(message)s",
            "datefmt": "%Y-%m-%dT%H:%M:%S%z",
        }

    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {"default": formatter},
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "default",
                    "stream": "ext://sys.stderr",
                },
            },
            "root": {"level": level, "handlers": ["console"]},
            # uvicorn gère ses propres loggers ; on les rattache au handler racine
            # pour un format homogène, sans dupliquer (propagate via root).
            "loggers": {
                "uvicorn": {"level": level, "handlers": ["console"], "propagate": False},
                "uvicorn.access": {"level": level, "handlers": ["console"], "propagate": False},
                "uvicorn.error": {"level": level, "handlers": ["console"], "propagate": False},
            },
        }
    )
