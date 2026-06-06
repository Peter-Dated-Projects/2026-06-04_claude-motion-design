"""Logging configuration for the rotoscoping microservice.

Single entry point `configure_logging()` wires a text log file
(`logs/rotoscoping.log`) plus a console stream. No database -- the proposal is
explicit that logs are plain text only. Call this once, early in startup, before
anything else logs.
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler

import config

_LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# The single log file the proposal names. Rotated so a long-lived service does
# not grow an unbounded file; still plain text, still no database.
_LOG_FILE = config.LOGS_DIR / "rotoscoping.log"

_configured = False


def configure_logging(level: int = logging.INFO) -> logging.Logger:
    """Idempotently configure root logging and return the service logger."""
    global _configured
    if not _configured:
        formatter = logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT)

        file_handler = RotatingFileHandler(
            _LOG_FILE,
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)

        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)

        root = logging.getLogger()
        root.setLevel(level)
        root.addHandler(file_handler)
        root.addHandler(console_handler)

        _configured = True

    return logging.getLogger("rotoscoping")
