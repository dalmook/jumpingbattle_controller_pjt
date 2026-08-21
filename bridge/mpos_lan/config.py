"""Configuration loading for the MPOS LAN client."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .exceptions import ConfigurationError


@dataclass(slots=True)
class MposConfig:
    host: str
    port: int
    dll_path: Path
    business_number: str = ""
    timeout_seconds: float = 40.0
    status_retries: int = 1
    database_path: Path = Path("mpos_transactions.db")
    log_path: Path = Path("mpos_lan.log")

    @classmethod
    def load(cls, path: str | Path | None = None) -> "MposConfig":
        """Load JSON configuration, then apply MPOS_* environment overrides."""
        source = Path(path or os.environ.get("MPOS_CONFIG", Path(__file__).with_name("config.json")))
        data: dict[str, Any] = {}
        if source.exists():
            try:
                data = json.loads(source.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ConfigurationError(f"설정 파일을 읽을 수 없습니다: {source}: {exc}") from exc
        elif path or os.environ.get("MPOS_CONFIG"):
            raise ConfigurationError(f"설정 파일이 없습니다: {source}")

        env_map = {
            "host": "MPOS_HOST",
            "port": "MPOS_PORT",
            "dll_path": "MPOS_DLL_PATH",
            "business_number": "MPOS_BUSINESS_NUMBER",
            "timeout_seconds": "MPOS_TIMEOUT",
            "status_retries": "MPOS_STATUS_RETRIES",
            "database_path": "MPOS_DB_PATH",
            "log_path": "MPOS_LOG_PATH",
        }
        for key, env_name in env_map.items():
            if env_name in os.environ:
                data[key] = os.environ[env_name]

        missing = [key for key in ("host", "port", "dll_path") if not data.get(key)]
        if missing:
            raise ConfigurationError("필수 설정이 없습니다: " + ", ".join(missing))

        base = source.parent.resolve()

        def resolve_path(value: str | Path) -> Path:
            candidate = Path(value).expanduser()
            return candidate.resolve() if candidate.is_absolute() else (base / candidate).resolve()

        try:
            result = cls(
                host=str(data["host"]).strip(),
                port=int(data["port"]),
                dll_path=resolve_path(data["dll_path"]),
                business_number=str(data.get("business_number", "")).strip(),
                timeout_seconds=float(data.get("timeout_seconds", 40.0)),
                status_retries=int(data.get("status_retries", 1)),
                database_path=resolve_path(data.get("database_path", "data/mpos_transactions.db")),
                log_path=resolve_path(data.get("log_path", "logs/mpos_lan.log")),
            )
        except (TypeError, ValueError) as exc:
            raise ConfigurationError(f"설정값 형식이 잘못되었습니다: {exc}") from exc
        result.validate()
        return result

    def validate(self) -> None:
        if not self.host:
            raise ConfigurationError("MPOS host가 비어 있습니다.")
        if not 1 <= self.port <= 65535:
            raise ConfigurationError("MPOS port는 1~65535 범위여야 합니다.")
        if self.timeout_seconds <= 0:
            raise ConfigurationError("timeout_seconds는 0보다 커야 합니다.")
        if self.status_retries < 0:
            raise ConfigurationError("status_retries는 0 이상이어야 합니다.")

    def require_payment_settings(self) -> None:
        if not self.business_number:
            raise ConfigurationError(
                "승인/취소에는 MPOS_BUSINESS_NUMBER 또는 config.json의 business_number가 필요합니다."
            )
