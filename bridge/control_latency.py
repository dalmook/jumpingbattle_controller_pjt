"""Low-overhead, non-sensitive latency tracing for remote-control commands.

Events are buffered in memory and flushed once at the end of a trace so the
instrumentation does not add a file write to every measured stage.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


_TRACE_PATTERN = re.compile(r"^(?:CTRL-[0-9a-f-]{36}|STATE-[0-9A-Z-]{8,64})$", re.I)
_WRITE_LOCK = threading.Lock()
_BLOCKED_DETAIL_KEYS = (
    "password",
    "token",
    "secret",
    "authorization",
    "cookie",
    "pan",
    "track",
    "pin",
    "card_number",
)


def command_trace_id(command_id: Any) -> str:
    candidate = str(command_id or "").strip().lower()
    try:
        return f"CTRL-{uuid.UUID(candidate)}"
    except (ValueError, AttributeError):
        return ""


def new_state_trace_id() -> str:
    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    return f"STATE-{stamp}-{uuid.uuid4().hex[:6].upper()}"


def _safe_details(details: dict[str, Any] | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in (details or {}).items():
        normalized = str(key).lower()
        if any(blocked in normalized for blocked in _BLOCKED_DETAIL_KEYS):
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            result[str(key)[:80]] = value if not isinstance(value, str) else value[:300]
    return result


class ControlLatencyTrace:
    """Collect monotonic durations for one control command or state cycle."""

    def __init__(
        self,
        trace_id: str,
        log_path: Path,
        *,
        kind: str,
        action: str = "",
        room_id: str = "",
    ):
        normalized = str(trace_id or "").strip()
        self.trace_id = normalized if _TRACE_PATTERN.fullmatch(normalized) else ""
        self.log_path = Path(log_path)
        self.kind = str(kind)[:40]
        self.action = str(action)[:40]
        self.room_id = str(room_id)[:20]
        self.started_ns = time.perf_counter_ns()
        self.events: list[dict[str, Any]] = []
        self._finished = False

    @property
    def enabled(self) -> bool:
        return bool(self.trace_id)

    def mark(
        self,
        stage: str,
        *,
        duration_ms: float | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        if not self.enabled or self._finished:
            return
        self.events.append(
            {
                "trace_id": self.trace_id,
                "kind": self.kind,
                "action": self.action,
                "room_id": self.room_id,
                "stage": str(stage)[:80],
                "iso_timestamp": datetime.now().astimezone().isoformat(
                    timespec="milliseconds"
                ),
                "elapsed_ms": round(
                    (time.perf_counter_ns() - self.started_ns) / 1_000_000, 3
                ),
                "duration_ms": (
                    None
                    if duration_ms is None
                    else round(max(0.0, float(duration_ms)), 3)
                ),
                "details": _safe_details(details),
            }
        )

    def finish(
        self,
        status: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        if not self.enabled or self._finished:
            return
        total_ms = (time.perf_counter_ns() - self.started_ns) / 1_000_000
        self.mark("TRACE_FINISHED", duration_ms=total_ms, details={"status": status, **(details or {})})
        self._finished = True
        # 계측 로그 실패가 정상 제어 명령의 성공/실패를 바꾸면 안 된다.
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with _WRITE_LOCK:
                with self.log_path.open("a", encoding="utf-8") as stream:
                    for event in self.events:
                        stream.write(
                            json.dumps(
                                event,
                                ensure_ascii=False,
                                separators=(",", ":"),
                            )
                            + "\n"
                        )
        except OSError as exc:
            logging.warning(
                "[CONTROL PERF] trace=%s 로그 저장 실패: %s",
                self.trace_id,
                exc,
            )
        logging.info(
            "[CONTROL PERF] trace=%s kind=%s action=%s total_ms=%.3f status=%s",
            self.trace_id,
            self.kind,
            self.action or "-",
            total_ms,
            status,
        )
