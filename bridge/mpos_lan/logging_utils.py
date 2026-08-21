"""Audit logging that deliberately excludes raw payment data."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import uuid

from .models import TransactionResult


def build_audit_logger(path: Path) -> logging.Logger:
    resolved = path.resolve()
    name = f"mpos_lan.audit.{resolved}.{uuid.uuid4()}"
    logger = logging.getLogger(name)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        resolved,
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


def close_audit_logger(logger: logging.Logger) -> None:
    for handler in list(logger.handlers):
        handler.flush()
        handler.close()
        logger.removeHandler(handler)


def mask_auth_no(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 2:
        return "*" * len(value)
    return value[:1] + "*" * (len(value) - 2) + value[-1:]


def log_transaction(logger: logging.Logger, result: TransactionResult) -> None:
    logger.info(
        "TX_ID=%s TYPE=%s AMOUNT=%s RESULT=%s RES_CODE=%s AUTH_NO=%s "
        "ERROR=%s ELAPSED_MS=%s",
        result.transaction_uuid,
        result.transaction_type.value,
        result.amount,
        result.status.value,
        result.response_code,
        mask_auth_no(result.auth_no),
        result.error_code.value,
        result.elapsed_ms,
    )
