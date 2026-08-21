"""Structured, non-sensitive latency tracing for one MPOS command."""

from __future__ import annotations

import json
import logging
import re
import secrets
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any


TRACE_ID_PATTERN = re.compile(r"^PAY-\d{8}-\d{6}-[A-Z0-9]{6}$")
_WRITE_LOCK = threading.Lock()
_FORBIDDEN_DETAIL_KEYS = ("pan", "track", "pin", "ic_raw", "card_number")
_LEAF_DURATION_STAGES = {
    "BRIDGE_SYNC_HTTP_ROUND_TRIP",
    "LOCK_ACQUIRED",
    "DEVICE_LOCK_ACQUIRED",
    "BRIDGE_DB_LOOKUP_DONE",
    "BRIDGE_DB_DONE",
    "FDK_CREATE_DONE",
    "FDK_INPUT_TOTAL",
    "STATUS_EXECUTE_DONE",
    "FIRST_DEVICE_RESPONSE",
    "FDK_OUTPUT_TOTAL",
    "FDK_DESTROY",
}


def valid_trace_id(value: Any) -> str:
    candidate = str(value or "").strip().upper()
    return candidate if TRACE_ID_PATTERN.fullmatch(candidate) else ""


def new_trace_id() -> str:
    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    return f"PAY-{stamp}-{secrets.token_hex(3).upper()}"


def _safe_details(details: dict[str, Any] | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in (details or {}).items():
        normalized = str(key).lower()
        if any(blocked in normalized for blocked in _FORBIDDEN_DETAIL_KEYS):
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            result[str(key)[:80]] = value if not isinstance(value, str) else value[:500]
    return result


class LatencyTrace:
    """Records per-process monotonic durations plus comparable wall timestamps."""

    def __init__(self, trace_id: str, log_path: Path):
        self.trace_id = valid_trace_id(trace_id)
        self.log_path = Path(log_path)
        self.started_ns = time.perf_counter_ns()
        self.events: list[dict[str, Any]] = []

    @property
    def enabled(self) -> bool:
        return bool(self.trace_id)

    def mark(
        self,
        stage: str,
        *,
        component: str = "bridge",
        duration_ms: float | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        if not self.enabled:
            return
        event = {
            "trace_id": self.trace_id,
            "component": component if component in {"bridge", "mpos"} else "bridge",
            "stage": str(stage)[:80],
            "iso_timestamp": datetime.now().astimezone().isoformat(timespec="milliseconds"),
            "elapsed_ms": round((time.perf_counter_ns() - self.started_ns) / 1_000_000, 3),
            "duration_ms": None if duration_ms is None else round(max(0.0, float(duration_ms)), 3),
            "details": _safe_details(details),
        }
        self.events.append(event)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with _WRITE_LOCK:
            with self.log_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        logging.info(
            "[PAY TRACE] trace=%s stage=%s elapsed_ms=%.3f duration_ms=%s",
            self.trace_id,
            event["stage"],
            event["elapsed_ms"],
            "-" if event["duration_ms"] is None else f"{event['duration_ms']:.3f}",
        )

    def callback(self, stage: str, duration_ms: float | None = None, details: dict[str, Any] | None = None) -> None:
        self.mark(stage, component="mpos", duration_ms=duration_ms, details=details)

    def public_events(self) -> list[dict[str, Any]]:
        return list(self.events)

    def log_summary(self) -> None:
        if not self.enabled:
            return
        total_ms = round((time.perf_counter_ns() - self.started_ns) / 1_000_000, 3)
        measured = sorted(
            (
                event
                for event in self.events
                if event.get("duration_ms") is not None
                and event.get("stage") in _LEAF_DURATION_STAGES
            ),
            key=lambda event: float(event["duration_ms"]),
            reverse=True,
        )
        top = measured[:3]
        lines = [
            "=" * 44,
            "MPOS PAYMENT LATENCY REPORT (BRIDGE)",
            "=" * 44,
            f"TRACE: {self.trace_id}",
            f"BRIDGE TOTAL: {total_ms / 1000:.3f} sec",
            "TOP LOCAL BOTTLENECKS:",
        ]
        lines.extend(
            f"{index}. {event['stage']} {float(event['duration_ms']) / 1000:.3f} sec"
            for index, event in enumerate(top, 1)
        )
        lines.append("=" * 44)
        logging.info("\n%s", "\n".join(lines))
