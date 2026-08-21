"""Read-only benchmark for Jumping Battle bridge latency.

This script never queues or executes start/stop/set-info commands.  It can
summarize the existing bridge log, inspect the manager window, and probe only
the MQTT CONNECT/CONNACK lifecycle.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

from jumping_bridge import BridgeConfig, MANAGER_TITLE, ManagerUI, ROOM_NAMES, manager_ui_from_config


HTTP_TRACE = re.compile(
    r"path=(/api/agent/(?:sync|payment-commands|ack)).*?"
    r"attempt=([0-9]+).*?result=ok elapsed_ms=([0-9.]+).*?"
    r"connection_reused=(True|False)"
)
LOG_TIMESTAMP = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})")


def stats(values: list[float], samples: int) -> dict[str, float | int]:
    selected = values[-samples:]
    ordered = sorted(selected)
    if not ordered:
        return {"count": 0}
    p95_index = min(len(ordered) - 1, max(0, int(len(ordered) * 0.95 + 0.999999) - 1))
    return {
        "count": len(ordered),
        "mean_ms": round(statistics.mean(ordered), 3),
        "min_ms": round(ordered[0], 3),
        "max_ms": round(ordered[-1], 3),
        "p50_ms": round(statistics.median(ordered), 3),
        "p95_ms": round(ordered[p95_index], 3),
    }


def timed_samples(operation: Callable[[], object], samples: int) -> list[float]:
    values: list[float] = []
    for _ in range(samples):
        started = time.perf_counter_ns()
        operation()
        values.append((time.perf_counter_ns() - started) / 1_000_000)
    return values


def summarize_log(path: Path, samples: int) -> dict[str, object]:
    values: dict[str, list[float]] = {
        "state_sync_http": [],
        "payment_fast_lane_http": [],
        "control_ack_http": [],
        "payment_ack_http": [],
    }
    timestamps: dict[str, list[datetime]] = {key: [] for key in values}
    reused: dict[str, list[bool]] = {key: [] for key in values}
    attempts: dict[str, list[int]] = {key: [] for key in values}
    if not path.exists():
        return {key: {"count": 0} for key in values}
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            match = HTTP_TRACE.search(line)
            if not match:
                continue
            route, attempt, elapsed, connection_reused = match.groups()
            duration = float(elapsed)
            key = ""
            if route.endswith("/sync"):
                key = "state_sync_http"
            elif route.endswith("/payment-commands"):
                key = "payment_fast_lane_http"
            elif "trace=-" in line:
                key = "control_ack_http"
            else:
                key = "payment_ack_http"
            values[key].append(duration)
            reused[key].append(connection_reused == "True")
            attempts[key].append(int(attempt))
            timestamp_match = LOG_TIMESTAMP.match(line)
            if timestamp_match:
                timestamps[key].append(
                    datetime.strptime(
                        timestamp_match.group(1), "%Y-%m-%d %H:%M:%S,%f"
                    )
                )

    report: dict[str, object] = {}
    for key, items in values.items():
        selected_timestamps = timestamps[key][-samples:]
        item_report = stats(items, samples)
        item_report.update(
            {
                "connection_reused_count": sum(reused[key][-samples:]),
                "retry_success_count": sum(
                    attempt > 1 for attempt in attempts[key][-samples:]
                ),
                "first_sample": (
                    selected_timestamps[0].isoformat(timespec="milliseconds")
                    if selected_timestamps
                    else ""
                ),
                "last_sample": (
                    selected_timestamps[-1].isoformat(timespec="milliseconds")
                    if selected_timestamps
                    else ""
                ),
            }
        )
        report[key] = item_report

    sync_times = timestamps["state_sync_http"][-(samples + 1):]
    sync_intervals = [
        (current - previous).total_seconds() * 1_000
        for previous, current in zip(sync_times, sync_times[1:])
    ]
    report["effective_state_cycle"] = stats(sync_intervals, samples)
    return report


def live_ui(samples: int) -> dict[str, dict[str, float | int]]:
    ui = ManagerUI(MANAGER_TITLE, info_api_enabled=False)
    ui._map_options = {
        room_id: ui._fallback_map_options(room_id) for room_id in ROOM_NAMES
    }
    window_discovery = timed_samples(ui._window, samples)
    cached_window = ui._window()
    full_reads = timed_samples(ui.read_rooms, samples)
    original_window = ui._window
    ui._window = lambda _perf_trace=None: cached_window  # type: ignore[method-assign]
    try:
        cached_reads = timed_samples(ui.read_rooms, samples)
    finally:
        ui._window = original_window  # type: ignore[method-assign]
    return {
        "manager_window_discovery": stats(window_discovery, samples),
        "manager_state_read_full": stats(full_reads, samples),
        "manager_state_read_cached_window": stats(cached_reads, samples),
    }


def mqtt_probe(config_path: Path, samples: int) -> dict[str, float | int]:
    config = BridgeConfig.load(config_path)
    info_api = manager_ui_from_config(config).info_api
    return stats(timed_samples(info_api.probe, samples), samples)


def main() -> int:
    default_log = (
        Path(os.environ.get("LOCALAPPDATA", "."))
        / "JumpingBattleRemoteBridge"
        / "jumping-bridge.log"
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--log", type=Path, default=default_log)
    parser.add_argument("--live-ui", action="store_true")
    parser.add_argument("--mqtt-config", type=Path)
    args = parser.parse_args()
    samples = max(1, min(500, args.samples))
    report: dict[str, object] = {
        "samples": samples,
        "existing_log": summarize_log(args.log, samples),
    }
    if args.live_ui:
        report["live_ui_read_only"] = live_ui(samples)
    if args.mqtt_config:
        report["manager_mqtt_connect_auth_disconnect"] = mqtt_probe(
            args.mqtt_config, samples
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
