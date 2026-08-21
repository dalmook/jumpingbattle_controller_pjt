from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import re
import socket
import sys
import threading
import time
import unicodedata
import urllib.parse
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from payment_service import DisabledPaymentService, PaymentService
from parking_service import DisabledParkingService, ParkingRegistrationService
from latency_trace import new_trace_id, valid_trace_id
from control_latency import (
    ControlLatencyTrace,
    command_trace_id,
    new_state_trace_id,
)
from local_payment_server import (
    LocalPaymentHttpServer,
    LocalPaymentRuntime,
    LocalPaymentStore,
)


VERSION = "0.7.9"
MAX_PROCESSED_COMMANDS = 200
MAX_COMMAND_RESULT_LENGTH = 4000
REMOTE_REQUEST_TIMEOUT = 8.0
REMOTE_REQUEST_ATTEMPTS = 2
REMOTE_RETRY_DELAY = 0.25
BRIDGE_HEARTBEAT_SECONDS = 2.0
STATE_SYNC_LOCK_TIMEOUT_SECONDS = 0.1
STATE_STALE_SECONDS = 5.0
SET_INFO_VERIFY_SKIP_SECONDS = 1.6
SET_INFO_VERIFY_SECONDS = 2.4
SET_INFO_VERIFY_POLL_SECONDS = 0.1
CONTROL_RECOVERY_REQUIRED_PROBES = 2
ACK_OUTBOX_FLUSH_SECONDS = 1.0
ACK_OUTBOX_BATCH_SIZE = 20
STOP_DIALOG_TIMEOUT_SECONDS = 5.0
STOP_STATUS_TIMEOUT_SECONDS = 3.0
STOP_POLL_SECONDS = 0.1
MANAGER_TITLE = "점핑배틀 관리자 프로그램"
ROOM_NAMES = {
    "0": ("A1(중)", "중형"),
    "1": ("C1(소)", "소형"),
    "2": ("B1(대)", "대형"),
    "3": ("C2(소2)", "소형"),
}
MAP_SUFFIXES = [
    "Basic",
    "Easy",
    "Normal",
    "HARD",
    "챌린저",
    "우주맵",
    "여름맵",
    "키즈맵",
    "산타맵",
    "발판테스트(개발중)",
]
PANEL_AUTO_ID = (
    "QApplication.dashboard_windows.centralwidget.widget_2.stackedWidget."
    "widget_game_frame.widget.scrollArea.qt_scrollarea_viewport."
    "scrollAreaWidgetContents.module_Game_pannel.WidgetPannel"
)
ROOM_CONTROL_IDS = {
    "title": ("ui_label_title", "Text"),
    "status": ("ui_label_game_status", "Text"),
    "map": ("ui_combo_map", "ComboBox"),
    "team": ("ui_edit_teamname", "Edit"),
    "people": ("ui_combo_people", "ComboBox"),
    "remaining": ("ui_label_last_time", "Text"),
    "score": ("ui_label_score", "Text"),
    "level": ("ui_label_level", "Text"),
    "play": ("ui_button_play", "Button"),
    "stop": ("ui_button_stop", "Button"),
    "info": ("ui_button_infoadd", "Button"),
}

# The manager already exposes this localhost MQTT channel for its companion app.
# v0.5.3 uses it for team/map input so Qt dropdowns normally do not need to be
# manipulated.  Start/stop still go through the manager's own buttons, preserving
# its timelapse, score, ranking and print lifecycle.
MANAGER_MQTT_HOST = "127.0.0.1"
MANAGER_MQTT_PORT = 1883
MANAGER_MQTT_TOPIC = "JP/app"
MAP_SERIALS = {
    "중형-Basic": 231,
    "중형-Easy": 215,
    "중형-Normal": 209,
    "중형-HARD": 214,
    "중형-챌린저": 253,
    "중형-우주맵": 252,
    "중형-여름맵": 261,
    "중형-키즈맵": 266,
    "중형-산타맵": 269,
    "소형-Basic": 236,
    "소형-Easy": 233,
    "소형-Normal": 234,
    "소형-HARD": 237,
    "소형-챌린저": 254,
    "소형-우주맵": 255,
    "소형-여름맵": 262,
    "소형-키즈맵": 267,
    "소형-산타맵": 270,
    "대형-Basic": 221,
    "대형-Easy": 213,
    "대형-Normal": 210,
    "대형-HARD": 212,
    "대형-챌린저": 256,
    "대형-우주맵": 217,
    "대형-여름맵": 250,
    "대형-키즈맵": 222,
    "대형-산타맵": 265,
}
DEFAULT_MANAGER_DIR = Path(
    r"D:\JumpingBattle\Manager"
)


@dataclass
class RoomState:
    roomId: str
    status: str = "offline"
    teamName: str = ""
    mapName: str = ""
    mapIndex: int = 0
    mapOptions: list[str] = field(default_factory=list)
    people: int = 0
    remainingSeconds: int = 0
    score: int = 0
    level: str = ""
    deadline: str = ""

    def public_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result.pop("deadline", None)
        return result


@dataclass
class BridgeConfig:
    server_url: str = "http://127.0.0.1:4173"
    agent_token: str = "development-agent-token-change-before-deploy"
    agent_id: str = "store-main"
    poll_seconds: float = 0.5
    payment_poll_seconds: float = 0.2
    control_poll_seconds: float = 0.2
    heartbeat_seconds: float = BRIDGE_HEARTBEAT_SECONDS
    parking_poll_seconds: float = 1.0
    armed: bool = False
    simulate: bool = False
    manager_dir: str = str(DEFAULT_MANAGER_DIR)
    manager_title: str = MANAGER_TITLE
    info_api_enabled: bool = True
    manager_mqtt_host: str = MANAGER_MQTT_HOST
    manager_mqtt_port: int = MANAGER_MQTT_PORT
    manager_mqtt_username: str = ""
    manager_mqtt_password: str = ""
    mpos_enabled: bool = True
    mpos_host: str = "192.0.2.54"
    mpos_port: int = 4600
    mpos_dll_path: str = "mpos_lan/vendor/FDK_Module_64bit.dll"
    mpos_business_number: str = ""
    mpos_timeout_seconds: float = 40.0
    mpos_status_retries: int = 1
    local_payment_enabled: bool = False
    local_payment_host: str = "127.0.0.1"
    local_payment_port: int = 8765
    local_payment_allowed_origins: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "BridgeConfig":
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        allowed = {field for field in cls.__dataclass_fields__}
        return cls(**{key: value for key, value in data.items() if key in allowed})


class StateStore:
    def __init__(self, path: Path):
        self.path = path
        self._save_lock = threading.RLock()
        self.rooms = {
            room_id: RoomState(roomId=room_id) for room_id in ROOM_NAMES
        }
        self.processed_commands: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self):
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))
            for room_id, raw in data.get("rooms", {}).items():
                if room_id in self.rooms and isinstance(raw, dict):
                    permitted = {
                        key: value
                        for key, value in raw.items()
                        if key in RoomState.__dataclass_fields__
                    }
                    self.rooms[room_id] = RoomState(**permitted)
            processed = data.get("processedCommands", {})
            if isinstance(processed, dict):
                for command_id, raw in list(processed.items())[-MAX_PROCESSED_COMMANDS:]:
                    if not isinstance(command_id, str) or not isinstance(raw, dict):
                        continue
                    status = str(raw.get("status", ""))
                    if status not in {"executing", "completed", "failed"}:
                        continue
                    raw_latency_events = raw.get("latencyEvents", [])
                    self.processed_commands[command_id] = {
                        "status": status,
                        "result": str(raw.get("result", ""))[:MAX_COMMAND_RESULT_LENGTH],
                        "roomId": str(raw.get("roomId", "")),
                        "recordedAt": str(raw.get("recordedAt", "")),
                        "errorCode": str(raw.get("errorCode", "")),
                        "errorScope": str(raw.get("errorScope", "")),
                        "roomControlState": str(raw.get("roomControlState", "")),
                        "ackPending": bool(raw.get("ackPending", False)),
                        "ackResolution": str(raw.get("ackResolution", "")),
                        "ackLastError": str(raw.get("ackLastError", ""))[
                            :MAX_COMMAND_RESULT_LENGTH
                        ],
                        "ackRoom": (
                            dict(raw.get("ackRoom", {}))
                            if isinstance(raw.get("ackRoom"), dict)
                            else None
                        ),
                        "traceId": str(raw.get("traceId", "")),
                        "latencyEvents": (
                            [
                                event
                                for event in raw_latency_events
                                if isinstance(event, dict)
                            ][:100]
                            if isinstance(raw_latency_events, list)
                            else []
                        ),
                    }
        except Exception:
            logging.exception("이전 상태 파일을 읽지 못했습니다.")

    def save(self):
        with self._save_lock:
            payload = {
                "version": VERSION,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "rooms": {key: asdict(value) for key, value in self.rooms.items()},
                "processedCommands": dict(self.processed_commands),
            }
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".tmp")
            last_error: PermissionError | None = None
            for attempt in range(4):
                try:
                    temp.write_text(
                        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
                    )
                    temp.replace(self.path)
                    return
                except PermissionError as exc:
                    last_error = exc
                    time.sleep(0.05 * (attempt + 1))
            if last_error is not None:
                raise last_error

    def mark_command(
        self,
        command_id: str,
        status: str,
        result: str,
        room_id: str = "",
        *,
        error_code: str = "",
        error_scope: str = "",
        room_control_state: str = "",
        ack_pending: bool = False,
        ack_room: dict[str, Any] | None = None,
        trace_id: str = "",
        latency_events: list[dict[str, Any]] | None = None,
    ):
        with self._save_lock:
            self.processed_commands[command_id] = {
                "status": status,
                "result": result[:MAX_COMMAND_RESULT_LENGTH],
                "roomId": room_id,
                "recordedAt": datetime.now(timezone.utc).isoformat(),
                "errorCode": error_code,
                "errorScope": error_scope,
                "roomControlState": room_control_state,
                "ackPending": bool(ack_pending),
                "ackResolution": "PENDING" if ack_pending else "",
                "ackLastError": "",
                "ackRoom": dict(ack_room) if isinstance(ack_room, dict) else None,
                "traceId": trace_id,
                "latencyEvents": list(latency_events or [])[:100],
            }
            while len(self.processed_commands) > MAX_PROCESSED_COMMANDS:
                self.processed_commands.pop(next(iter(self.processed_commands)))
            self.save()

    def set_ack_pending(
        self,
        command_id: str,
        pending: bool,
        *,
        resolution: str = "",
        error: str = "",
    ):
        with self._save_lock:
            command = self.processed_commands.get(command_id)
            if command is None:
                return
            command["ackPending"] = bool(pending)
            command["ackResolution"] = (
                resolution or ("PENDING" if pending else "ACKED")
            )
            command["ackLastError"] = str(error)[:MAX_COMMAND_RESULT_LENGTH]
            command["recordedAt"] = datetime.now(timezone.utc).isoformat()
            self.save()

    def is_ack_pending(self, command_id: str) -> bool:
        with self._save_lock:
            command = self.processed_commands.get(command_id)
            return bool(command and command.get("ackPending", False))

    def pending_ack_commands(
        self, limit: int = ACK_OUTBOX_BATCH_SIZE
    ) -> list[tuple[str, dict[str, Any]]]:
        with self._save_lock:
            pending: list[tuple[str, dict[str, Any]]] = []
            for command_id, command in self.processed_commands.items():
                if command.get("status") not in {"completed", "failed"}:
                    continue
                if not command.get("ackPending", False):
                    continue
                snapshot = dict(command)
                if isinstance(snapshot.get("ackRoom"), dict):
                    snapshot["ackRoom"] = dict(snapshot["ackRoom"])
                pending.append((command_id, snapshot))
                if len(pending) >= max(1, int(limit)):
                    break
            return pending

    def has_unresolved_commands(self) -> bool:
        """Return whether execution or its server acknowledgement is unresolved."""

        with self._save_lock:
            return any(
                command.get("status") == "executing"
                or bool(command.get("ackPending", False))
                for command in self.processed_commands.values()
            )

    def update_remaining(self):
        now = datetime.now(timezone.utc)
        for room in self.rooms.values():
            if room.status != "running" or not room.deadline:
                continue
            try:
                deadline = datetime.fromisoformat(room.deadline)
            except ValueError:
                room.deadline = ""
                continue
            room.remainingSeconds = max(0, int((deadline - now).total_seconds()))


class ManagerLogReader:
    START_RE = re.compile(r"\[GameModule\]\s*>>\s*(.+?)\s+게임 시작")
    STOP_RE = re.compile(r"\[GameModule\]\s*>>\s*(.+?)\s+게임 정지")
    SCORE_RE = re.compile(
        r"점수 데이터 수신\[(\d+)\]\s+score:\s*(-?\d+)\s*/\s*map:\s*(.+?)\s*$"
    )

    def __init__(self, manager_dir: Path):
        self.log_dir = manager_dir / "file" / "log"
        self.current_path: Path | None = None
        self.position = 0

    def _latest_log(self) -> Path | None:
        if not self.log_dir.exists():
            return None
        candidates = sorted(
            self.log_dir.glob("*_log.txt"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        return candidates[0] if candidates else None

    def apply(self, rooms: dict[str, RoomState]):
        latest = self._latest_log()
        if latest is None:
            return
        if latest != self.current_path:
            self.current_path = latest
            self.position = max(0, latest.stat().st_size - 24_000)

        try:
            with latest.open("r", encoding="utf-8", errors="replace") as handle:
                handle.seek(self.position)
                lines = handle.readlines()
                self.position = handle.tell()
        except OSError:
            logging.exception("관리자 로그를 읽지 못했습니다.")
            return

        name_to_id = {name: room_id for room_id, (name, _size) in ROOM_NAMES.items()}
        for line in lines:
            start = self.START_RE.search(line)
            if start and start.group(1) in name_to_id:
                room = rooms[name_to_id[start.group(1)]]
                room.status = "running"
                room.score = 0
                room.level = "gamestart"
                continue

            stop = self.STOP_RE.search(line)
            if stop and stop.group(1) in name_to_id:
                room = rooms[name_to_id[stop.group(1)]]
                room.status = "waiting"
                room.remainingSeconds = 0
                room.deadline = ""
                continue

            score = self.SCORE_RE.search(line)
            if score and score.group(1) in rooms:
                room = rooms[score.group(1)]
                room.score = max(0, int(score.group(2)))
                room.level = score.group(3).strip()


class InfoApiUnsupported(RuntimeError):
    """The manager's app API cannot represent this specific input."""


class ControlCommandError(RuntimeError):
    """A classified control failure that can be scoped without replaying it."""

    def __init__(self, message: str, *, error_code: str, scope: str):
        super().__init__(message)
        self.error_code = error_code
        self.scope = scope


class RoomControlError(ControlCommandError):
    def __init__(
        self,
        message: str,
        *,
        error_code: str,
        room_control_state: str = "CONTROL_FAILED",
    ):
        super().__init__(message, error_code=error_code, scope="room")
        self.room_control_state = room_control_state


class SetInfoVerificationError(RoomControlError):
    def __init__(
        self,
        message: str,
        *,
        error_code: str,
        attempts: int,
        team_ok: bool,
        map_ok: bool,
    ):
        super().__init__(
            message,
            error_code=error_code,
            room_control_state="SET_INFO_FAILED",
        )
        self.attempts = attempts
        self.team_ok = team_ok
        self.map_ok = map_ok


class SetInfoRoomBusyError(RoomControlError):
    def __init__(self, message: str):
        super().__init__(
            message,
            error_code="ROOM_ALREADY_PLAYING",
            room_control_state="SET_INFO_FAILED",
        )


class UiaFallbackError(RoomControlError):
    def __init__(self, message: str):
        super().__init__(
            message,
            error_code="UIA_FALLBACK_FAILED",
            room_control_state="SET_INFO_FAILED",
        )


class RoomStateReadError(RoomControlError):
    def __init__(self, message: str):
        super().__init__(
            message,
            error_code="STATE_READ_FAILED",
            room_control_state="SET_INFO_FAILED",
        )


class ManagerControlError(ControlCommandError):
    def __init__(self, message: str, *, error_code: str):
        super().__init__(message, error_code=error_code, scope="global")


class ManagerTransportError(ManagerControlError):
    def __init__(self, message: str):
        super().__init__(message, error_code="MANAGER_SEND_FAILED")


class ManagerStateUnavailableError(ManagerControlError):
    def __init__(
        self, message: str, *, error_code: str = "MANAGER_STATE_UNAVAILABLE"
    ):
        super().__init__(message, error_code=error_code)


class LocalMqttPublisher:
    """Small MQTT 3.1.1 QoS-0 publisher using only the Python standard library."""

    def __init__(
        self,
        host: str = MANAGER_MQTT_HOST,
        port: int = MANAGER_MQTT_PORT,
        username: str = "",
        password: str = "",
        timeout: float = 2.0,
    ):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.timeout = timeout

    @staticmethod
    def _mqtt_string(value: str) -> bytes:
        encoded = value.encode("utf-8")
        if len(encoded) > 65_535:
            raise ValueError("MQTT 문자열이 너무 깁니다.")
        return len(encoded).to_bytes(2, "big") + encoded

    @staticmethod
    def _remaining_length(value: int) -> bytes:
        if value < 0 or value > 268_435_455:
            raise ValueError("MQTT 패킷 크기가 올바르지 않습니다.")
        result = bytearray()
        while True:
            digit = value % 128
            value //= 128
            if value:
                digit |= 0x80
            result.append(digit)
            if not value:
                return bytes(result)

    def _connect_packet(self, client_id: str) -> bytes:
        variable_header = (
            self._mqtt_string("MQTT")
            + bytes((4, 0xC2))
            + (10).to_bytes(2, "big")
        )
        payload = (
            self._mqtt_string(client_id)
            + self._mqtt_string(self.username)
            + self._mqtt_string(self.password)
        )
        body = variable_header + payload
        return bytes((0x10,)) + self._remaining_length(len(body)) + body

    def _publish_packet(self, topic: str, payload: bytes) -> bytes:
        body = self._mqtt_string(topic) + payload
        return bytes((0x30,)) + self._remaining_length(len(body)) + body

    @staticmethod
    def _recv_exact(connection: socket.socket, size: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < size:
            chunk = connection.recv(size - len(chunks))
            if not chunk:
                raise RuntimeError("관리자 MQTT 연결이 응답 전에 종료되었습니다.")
            chunks.extend(chunk)
        return bytes(chunks)

    def _connect(
        self, perf_trace: ControlLatencyTrace | None = None
    ) -> socket.socket:
        if not self.username or not self.password:
            raise RuntimeError(
                "관리자 내부 API 계정이 bridge-config.json에 설정되지 않았습니다."
            )
        connection: socket.socket | None = None
        try:
            connect_started = time.perf_counter()
            connection = socket.create_connection(
                (self.host, self.port), timeout=self.timeout
            )
            if perf_trace is not None:
                perf_trace.mark(
                    "MANAGER_MQTT_TCP_CONNECT",
                    duration_ms=(time.perf_counter() - connect_started) * 1000,
                )
            connection.settimeout(self.timeout)
            client_id = f"jumping-bridge-{uuid.uuid4().hex[:12]}"
            auth_started = time.perf_counter()
            connection.sendall(self._connect_packet(client_id))
            response = self._recv_exact(connection, 4)
            if perf_trace is not None:
                perf_trace.mark(
                    "MANAGER_MQTT_AUTH_ACK",
                    duration_ms=(time.perf_counter() - auth_started) * 1000,
                )
            if response[:3] != b"\x20\x02\x00" or response[3] != 0:
                code = response[3] if len(response) == 4 else -1
                raise RuntimeError(f"관리자 MQTT 인증에 실패했습니다(코드 {code}).")
            return connection
        except OSError as exc:
            if connection is not None:
                connection.close()
            raise RuntimeError(
                "관리자 내부 API(MQTT)에 연결하지 못했습니다. Mosquitto 실행 상태를 확인해 주세요."
            ) from exc
        except Exception:
            if connection is not None:
                connection.close()
            raise

    def probe(self, perf_trace: ControlLatencyTrace | None = None):
        connection = self._connect(perf_trace)
        try:
            connection.sendall(b"\xe0\x00")
        finally:
            connection.close()

    def publish_json(
        self,
        topic: str,
        payload: dict[str, Any],
        perf_trace: ControlLatencyTrace | None = None,
    ):
        serialize_started = time.perf_counter()
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        if perf_trace is not None:
            perf_trace.mark(
                "MANAGER_REQUEST_SERIALIZE",
                duration_ms=(time.perf_counter() - serialize_started) * 1000,
                details={"bytes": len(encoded)},
            )
        connection = self._connect(perf_trace)
        try:
            send_started = time.perf_counter()
            connection.sendall(self._publish_packet(topic, encoded))
            if perf_trace is not None:
                perf_trace.mark(
                    "MANAGER_MQTT_SEND",
                    duration_ms=(time.perf_counter() - send_started) * 1000,
                )
            connection.sendall(b"\xe0\x00")
        finally:
            disconnect_started = time.perf_counter()
            connection.close()
            if perf_trace is not None:
                perf_trace.mark(
                    "MANAGER_MQTT_DISCONNECT",
                    duration_ms=(time.perf_counter() - disconnect_started) * 1000,
                )


class ManagerInfoApi:
    def __init__(self, publisher: LocalMqttPublisher | None = None):
        self.publisher = publisher or LocalMqttPublisher()

    def probe(self, perf_trace: ControlLatencyTrace | None = None):
        self.publisher.probe(perf_trace)

    def send(
        self,
        room_id: str,
        map_name: str,
        team_name: str,
        people: int,
        perf_trace: ControlLatencyTrace | None = None,
    ) -> int:
        map_serial = MAP_SERIALS.get(map_name)
        if map_serial is None:
            raise InfoApiUnsupported(
                f"{map_name or '현재 맵'}은 관리자 내부 API 번호가 없어 기존 방식으로 처리합니다."
            )
        if not team_name:
            # The manager treats an empty string as a request to generate a new
            # team name, so never send it when the operator intended no change.
            raise InfoApiUnsupported(
                "현재 팀명이 비어 있어 내부 API 대신 기존 방식으로 처리합니다."
            )
        manager_payload = {
            "cmd": "infook",
            "id": int(room_id),
            "map_serial": map_serial,
            "teamname": team_name[:10],
            "num_people": max(0, min(10, int(people))),
        }
        if perf_trace is None:
            self.publisher.publish_json(MANAGER_MQTT_TOPIC, manager_payload)
        else:
            self.publisher.publish_json(
                MANAGER_MQTT_TOPIC, manager_payload, perf_trace
            )
        return map_serial


class ManagerUI:
    def __init__(
        self,
        title: str,
        *,
        info_api_enabled: bool = True,
        info_api: ManagerInfoApi | None = None,
    ):
        self.title = title
        self._map_options: dict[str, list[str]] = {}
        self._cached_window = None
        self._window_cache_lock = threading.Lock()
        self.info_api_enabled = info_api_enabled
        self.info_api = info_api or ManagerInfoApi()

    def _window(self, perf_trace: ControlLatencyTrace | None = None):
        discovery_started = time.perf_counter()
        with self._window_cache_lock:
            cached = self._cached_window
        if cached is not None:
            try:
                if self.title in cached.window_text():
                    if perf_trace is not None:
                        perf_trace.mark(
                            "MANAGER_WINDOW_CACHE_HIT",
                            duration_ms=(time.perf_counter() - discovery_started) * 1000,
                        )
                    return cached
            except Exception:
                pass
            with self._window_cache_lock:
                if self._cached_window is cached:
                    self._cached_window = None
        try:
            from pywinauto import Desktop
        except ImportError as exc:
            raise RuntimeError("화면 제어 구성요소를 불러오지 못했습니다.") from exc

        candidates = []
        try:
            windows = Desktop(backend="uia").windows()
        except Exception as exc:
            raise RuntimeError("Windows 화면 제어 연결을 준비하지 못했습니다.") from exc
        for window in windows:
            try:
                title = window.window_text()
            except Exception:
                continue
            if self.title in title:
                candidates.append(window)

        if not candidates:
            raise RuntimeError(
                "점핑배틀 관리자 창을 찾지 못했습니다. 같은 Windows 사용자 화면에서 실행해 주세요."
            )
        if len(candidates) != 1:
            raise RuntimeError(
                f"점핑배틀 관리자 창이 {len(candidates)}개 발견되어 안전하게 선택할 수 없습니다."
            )
        if perf_trace is not None:
            perf_trace.mark(
                "MANAGER_WINDOW_DISCOVERY",
                duration_ms=(time.perf_counter() - discovery_started) * 1000,
                details={"candidateCount": len(candidates)},
            )
        selected = candidates[0]
        with self._window_cache_lock:
            self._cached_window = selected
        return selected

    @staticmethod
    def _control_text_result(control) -> tuple[bool, str]:
        for getter_name in ("get_value", "window_text"):
            getter = getattr(control, getter_name, None)
            if getter is None:
                continue
            try:
                value = getter()
            except Exception:
                continue
            if value is not None:
                return True, str(value).strip()
        return False, ""

    @staticmethod
    def _control_text(control) -> str:
        return ManagerUI._control_text_result(control)[1]

    def _controls(self, window, name: str):
        object_name, control_type = ROOM_CONTROL_IDS[name]
        auto_id = f"{PANEL_AUTO_ID}.{object_name}"
        controls = [
            control
            for control in window.descendants(control_type=control_type)
            if str(getattr(control.element_info, "automation_id", "")) == auto_id
        ]
        if len(controls) != len(ROOM_NAMES):
            raise RuntimeError(
                f"관리자 화면의 {object_name} 구성요소가 {len(controls)}개라 제어를 중단했습니다."
            )
        try:
            return sorted(
                controls,
                key=lambda control: (
                    control.rectangle().top,
                    control.rectangle().left,
                ),
            )
        except Exception as exc:
            raise RuntimeError(
                f"관리자 화면의 {object_name} 위치를 확인하지 못해 제어를 중단했습니다."
            ) from exc

    def _validate_room_order(self, window):
        titles = self._controls(window, "title")
        for room_id, (expected, _size) in ROOM_NAMES.items():
            actual = self._control_text(titles[int(room_id)]).strip()
            if expected not in actual:
                raise RuntimeError(
                    f"게임존 순서가 예상과 다릅니다: {room_id}번 {actual or '이름 없음'}"
                )

    def _control(self, window, room_id: str, name: str):
        if room_id not in ROOM_NAMES:
            raise RuntimeError("지원하지 않는 게임존입니다.")
        self._validate_room_order(window)
        return self._controls(window, name)[int(room_id)]

    def _room_controls(self, window, room_id: str, names: tuple[str, ...]):
        """Resolve one room's controls with a single room-order validation."""
        if room_id not in ROOM_NAMES:
            raise RuntimeError("지원하지 않는 게임존입니다.")
        self._validate_room_order(window)
        index = int(room_id)
        return {name: self._controls(window, name)[index] for name in names}

    def _selected_text_result(self, combo) -> tuple[bool, str]:
        try:
            value = combo.selected_text()
            if value is not None:
                return True, str(value).strip()
        except Exception:
            pass
        return self._control_text_result(combo)

    def _selected_text(self, combo) -> str:
        return self._selected_text_result(combo)[1]

    def _combo_options(self, combo) -> list[str]:
        options: list[str] = []
        try:
            try:
                combo.expand()
                deadline = time.monotonic() + 1.5
                while time.monotonic() < deadline and not options:
                    try:
                        items = combo.descendants(control_type="ListItem")
                        for item in items:
                            text = self._control_text(item)[:80]
                            if text:
                                options.append(text)
                        options = options[:50]
                    except Exception:
                        options = []
                    if not options:
                        time.sleep(0.05)
            except Exception:
                options = []
        finally:
            try:
                combo.collapse()
            except Exception:
                pass
        return list(dict.fromkeys(options))

    @staticmethod
    def _people_index(selected_text: str) -> int:
        text = selected_text.strip()
        if text == "기타":
            return 10
        match = re.fullmatch(r"([1-9])명", text)
        return int(match.group(1)) if match else 0

    @staticmethod
    def _fallback_map_options(room_id: str) -> list[str]:
        if room_id == "2":
            # The B1 (large) panel is a dual-mode room.  The manager's exact Qt
            # order is the complete large set followed by the complete medium
            # set, including each hidden development-test item.
            return [
                *(f"대형-{suffix}" for suffix in MAP_SUFFIXES),
                *(f"중형-{suffix}" for suffix in MAP_SUFFIXES),
            ]
        room_size = ROOM_NAMES[room_id][1]
        return [f"{room_size}-{suffix}" for suffix in MAP_SUFFIXES]

    @staticmethod
    def _map_combo_index(room_id: str, logical_map_index: int) -> int:
        """Translate the website difficulty index to the Qt combo index.

        B1's large panel supports both large and medium modes.  Its first ten
        items are the large set and the medium set follows them.  Website map
        indexes use that same order, so no room-specific offset is required.
        """
        return logical_map_index - 1

    def _map_options_for_write(self, room_id: str) -> list[str]:
        """Return the manager-version map order without opening a live combo.

        A write command must not expand a room's map popup merely to discover
        values that are already fixed for this manager version.  In particular,
        B1 exposes only part of its dual-mode list intermittently through UIA.
        Using the verified full order keeps API-capable maps entirely on the
        manager API path and gives the B1 medium fallback an exact Qt index.
        The committed map text is still verified after every write.
        """
        options = self._map_options.get(room_id)
        if options:
            return options
        options = self._fallback_map_options(room_id)
        self._map_options[room_id] = options
        return options

    def _ensure_map_options(self, room_id: str, map_combo, status: str):
        if self._map_options.get(room_id):
            return
        if room_id == "2":
            # UI Automation may expose only the currently visible half of B1's
            # dual-mode popup.  The manager source defines a stable full order,
            # so use it directly without opening or scrolling the live combo.
            self._map_options[room_id] = self._fallback_map_options(room_id)
            return
        if status == "running":
            return
        discovered = self._combo_options(map_combo)
        expected_prefix = f"{ROOM_NAMES[room_id][1]}-"
        if discovered and all(option.startswith(expected_prefix) for option in discovered):
            self._map_options[room_id] = discovered
            logging.info("%s 맵 목록 확인: %s", ROOM_NAMES[room_id][0], ", ".join(discovered))
            return

        # Qt가 이전 방의 열린 팝업 목록을 돌려주는 경우가 있다. 방 크기가
        # 맞지 않는 목록은 절대 재사용하지 않고 이 관리자 버전의 방별 기본
        # 목록을 사용한다.
        self._map_options[room_id] = self._fallback_map_options(room_id)
        logging.warning(
            "%s 맵 목록을 방별로 읽지 못해 안전한 기본 목록 사용 (읽은 값: %s)",
            ROOM_NAMES[room_id][0],
            ", ".join(discovered) or "없음",
        )

    def _wait_control_text(self, control, expected: str, error: str):
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            if self._control_text(control) == expected:
                return
            time.sleep(0.05)
        raise RuntimeError(error)

    def _combo_selection_state(
        self, combo, expected: str, accepted_aliases: set[str] | None = None
    ) -> bool | None:
        """Return the committed ComboBox value when Qt exposes it.

        A highlighted popup ListItem is not proof that QComboBox committed the
        choice, so SelectionItem.is_selected is intentionally not used here.
        """
        accepted = {expected, *(accepted_aliases or set())}
        selected_text = self._selected_text(combo)
        if selected_text:
            return selected_text in accepted

        try:
            get_selection = getattr(combo, "get_selection", None)
            if get_selection is not None:
                selected = list(get_selection() or [])
                if selected:
                    return any(self._control_text(value) in accepted for value in selected)
        except Exception:
            pass
        return None

    @staticmethod
    def _normalize_team_for_compare(value: str) -> str:
        # Preserve exact Korean/ASCII semantics while normalizing only the
        # canonical Unicode representation (composed vs decomposed Hangul).
        return unicodedata.normalize("NFC", str(value or "")).strip()

    def _bounded_room_controls(
        self,
        room_id: str,
        names: tuple[str, ...],
        initial_window=None,
    ):
        """Resolve one room's controls without promoting a room miss globally."""

        deadline = time.monotonic() + SET_INFO_VERIFY_SKIP_SECONDS
        window = initial_window
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            if window is None:
                try:
                    window = self._window()
                except Exception as exc:
                    raise ManagerStateUnavailableError(
                        "관리자 프로그램 창을 확인하지 못했습니다."
                    ) from exc
            try:
                return window, self._room_controls(window, room_id, names)
            except Exception as exc:
                last_error = exc
                window = None
                time.sleep(SET_INFO_VERIFY_POLL_SECONDS)
        raise RoomStateReadError(
            "해당 방의 최신 입력 구성요소를 확인하지 못했습니다."
        ) from last_error

    def _fresh_room_info_snapshot(self, room_id: str) -> dict[str, Any]:
        """Read the requested room from newly resolved UIA controls.

        The returned timestamp belongs to this read, not to the bridge's cached
        room snapshot.  This is intentionally a narrow read so verification
        does not hydrate every room or consult Cloud/D1 state.
        """

        observed_at = datetime.now().astimezone().isoformat(timespec="milliseconds")
        observed_monotonic = time.monotonic()
        try:
            window = self._window()
        except Exception as exc:
            raise ManagerStateUnavailableError(
                "관리자 프로그램 창을 확인하지 못했습니다."
            ) from exc
        try:
            controls = self._room_controls(
                window,
                room_id,
                ("status", "team", "map", "people"),
            )
            status_readable, status_text = self._control_text_result(controls["status"])
            team_readable, team_text = self._control_text_result(controls["team"])
            map_readable, map_text = self._selected_text_result(controls["map"])
            people_readable, people_text = self._selected_text_result(controls["people"])
            if not status_readable or not status_text.strip():
                raise RoomStateReadError(
                    "해당 방의 최신 실행 상태를 읽지 못했습니다."
                )
            normalized_map = self._normalize_map_name(room_id, map_text)
            options = self._map_options_for_write(room_id)
            map_index = (
                options.index(normalized_map) + 1 if normalized_map in options else 0
            )
        except RoomControlError:
            raise
        except Exception as exc:
            raise RoomStateReadError(
                "해당 방의 최신 팀명·맵·인원 상태를 읽지 못했습니다."
            ) from exc
        return {
            "observedAt": observed_at,
            "observedMonotonic": observed_monotonic,
            "statusReadable": status_readable,
            "status": status_text,
            "teamReadable": team_readable,
            "team": team_text,
            "mapReadable": map_readable,
            "map": normalized_map,
            "mapIndex": map_index,
            "peopleReadable": people_readable,
            "people": people_text,
        }

    def _verify_set_info_applied(
        self,
        room_id: str,
        target_team: str,
        target_map: str,
        target_map_index: int,
        expected_people: str,
        skip_people: bool,
        perf_trace: ControlLatencyTrace | None = None,
    ):
        started_at = time.monotonic()
        not_before = started_at if skip_people else started_at + 0.55
        timeout_seconds = (
            SET_INFO_VERIFY_SKIP_SECONDS if skip_people else SET_INFO_VERIFY_SECONDS
        )
        deadline = started_at + timeout_seconds
        attempts = 0
        last_snapshot: dict[str, Any] | None = None
        last_team_ok = False
        last_map_ok = False
        last_people_ok: bool | None = True if skip_people else None
        read_errors = 0
        if perf_trace is not None:
            perf_trace.mark(
                "VERIFY_START",
                details={"timeoutMs": int(timeout_seconds * 1000)},
            )

        while time.monotonic() < deadline:
            attempts += 1
            try:
                snapshot = self._fresh_room_info_snapshot(room_id)
            except ManagerStateUnavailableError:
                raise
            except Exception as exc:
                read_errors += 1
                if perf_trace is not None:
                    perf_trace.mark(
                        "VERIFY_ATTEMPT",
                        details={
                            "attempt": attempts,
                            "stateReadable": False,
                            "errorType": type(exc).__name__,
                        },
                    )
                time.sleep(SET_INFO_VERIFY_POLL_SECONDS)
                continue

            last_snapshot = snapshot
            actual_team = self._normalize_team_for_compare(snapshot["team"])
            expected_team = self._normalize_team_for_compare(target_team)
            last_team_ok = bool(snapshot["teamReadable"]) and actual_team == expected_team
            last_map_ok = (
                bool(snapshot["mapReadable"])
                and snapshot["map"] == target_map
                and (
                    target_map_index <= 0
                    or int(snapshot["mapIndex"]) == target_map_index
                )
            )
            if skip_people:
                last_people_ok = True
            elif snapshot["peopleReadable"]:
                last_people_ok = snapshot["people"] == expected_people
            else:
                # When people are part of this command, an unreadable value is
                # not evidence that the Manager applied it.
                last_people_ok = False

            freshness_ms = max(
                0.0,
                (time.monotonic() - float(snapshot["observedMonotonic"])) * 1000,
            )
            if perf_trace is not None:
                perf_trace.mark(
                    "VERIFY_FRESH_STATE_AT",
                    details={
                        "attempt": attempts,
                        "observedAt": snapshot["observedAt"],
                        "freshnessMs": round(freshness_ms, 3),
                    },
                )
                perf_trace.mark(
                    "VERIFY_ATTEMPT",
                    details={
                        "attempt": attempts,
                        "stateReadable": bool(
                            snapshot["teamReadable"] and snapshot["mapReadable"]
                        ),
                        "teamOk": last_team_ok,
                        "mapOk": last_map_ok,
                        "peopleOk": last_people_ok,
                    },
                )

            if (
                time.monotonic() >= not_before
                and last_team_ok
                and last_map_ok
                and last_people_ok
            ):
                elapsed_ms = (time.monotonic() - started_at) * 1000
                if perf_trace is not None:
                    perf_trace.mark("VERIFY_TEAM_OK", details={"attempt": attempts})
                    perf_trace.mark("VERIFY_MAP_OK", details={"attempt": attempts})
                    perf_trace.mark(
                        "VERIFY_DONE",
                        duration_ms=elapsed_ms,
                        details={"attempts": attempts, "result": "matched"},
                    )
                    perf_trace.mark(
                        "MANAGER_RESPONSE_ACK",
                        duration_ms=elapsed_ms,
                        details={"method": "mqtt-fresh-ui-verify"},
                    )
                return
            time.sleep(SET_INFO_VERIFY_POLL_SECONDS)

        if last_snapshot is None:
            if perf_trace is not None:
                perf_trace.mark(
                    "VERIFY_DONE",
                    duration_ms=(time.monotonic() - started_at) * 1000,
                    details={
                        "attempts": attempts,
                        "result": "state-unavailable",
                        "readErrors": read_errors,
                    },
                )
            raise RoomStateReadError(
                "해당 방의 최신 상태를 제한 시간 안에 읽지 못해 입력 결과를 확정하지 않았습니다."
            )

        state_readable = bool(
            last_snapshot["teamReadable"] and last_snapshot["mapReadable"]
        )
        if not state_readable:
            if perf_trace is not None:
                perf_trace.mark(
                    "VERIFY_TEAM_FAILED",
                    details={"attempts": attempts, "stateReadable": False},
                )
                perf_trace.mark(
                    "VERIFY_MAP_FAILED",
                    details={"attempts": attempts, "stateReadable": False},
                )
                perf_trace.mark(
                    "VERIFY_DONE",
                    duration_ms=(time.monotonic() - started_at) * 1000,
                    details={
                        "attempts": attempts,
                        "result": "STATE_READ_FAILED",
                        "readErrors": read_errors,
                    },
                )
            raise RoomStateReadError(
                "관리자 프로그램의 최신 팀명·맵 상태를 읽지 못해 입력 결과를 확정하지 않았습니다.",
            )
        if not last_team_ok and not last_map_ok:
            error_code = "TEAM_AND_MAP_VERIFY_FAILED"
        elif not last_team_ok:
            error_code = "TEAM_VERIFY_FAILED"
        elif not last_map_ok:
            error_code = "MAP_VERIFY_FAILED"
        else:
            error_code = "PEOPLE_VERIFY_FAILED"
        if perf_trace is not None:
            perf_trace.mark(
                "VERIFY_TEAM_OK" if last_team_ok else "VERIFY_TEAM_FAILED",
                details={"attempts": attempts},
            )
            perf_trace.mark(
                "VERIFY_MAP_OK" if last_map_ok else "VERIFY_MAP_FAILED",
                details={"attempts": attempts},
            )
            perf_trace.mark(
                "VERIFY_DONE",
                duration_ms=(time.monotonic() - started_at) * 1000,
                details={
                    "attempts": attempts,
                    "result": error_code,
                    "readErrors": read_errors,
                },
            )
        raise SetInfoVerificationError(
            "관리자 내부 API 전송 후 최신 팀명·맵 반영 결과가 일치하지 않았습니다.",
            error_code=error_code,
            attempts=attempts,
            team_ok=last_team_ok,
            map_ok=last_map_ok,
        )

    def _wait_combo_selection(
        self,
        combo,
        expected: str,
        error: str,
        method: str,
        accepted_aliases: set[str] | None = None,
    ):
        deadline = time.monotonic() + 1.5
        verification_available = False
        while time.monotonic() < deadline:
            state = self._combo_selection_state(combo, expected, accepted_aliases)
            if state is True:
                logging.info("콤보 선택 확정(%s): %s", method, expected)
                return
            if state is False:
                verification_available = True
            time.sleep(0.05)
        if not verification_available:
            # 인원 콤보처럼 Qt가 확정값을 전혀 노출하지 않는 경우에는 단순
            # highlight가 아닌 Invoke/Enter 활성화 성공을 근거로 계속한다.
            logging.info("Qt 콤보 값을 읽을 수 없어 활성화 성공(%s)으로 확인: %s", method, expected)
            return
        raise RuntimeError(error)

    @staticmethod
    def _keyboard_select_index(combo, index: int, popup_items=None):
        """Select a zero-based QComboBox index without moving the mouse.

        Qt keeps keyboard focus on the previous line edit even after UIA expands
        a combo.  Focusing the first popup item and sending the complete key
        sequence in one call makes Enter activate the QComboBox item.  It also
        lets B1 navigate past the ten initially visible medium-mode rows.
        """
        combo.expand()
        items = list(popup_items or [])
        keyboard_target = combo
        if items:
            first_item = items[0]
            try:
                first_item.select()
            except Exception:
                pass
            if callable(getattr(first_item, "type_keys", None)):
                keyboard_target = first_item
        keyboard_target.set_focus()
        keys = "{HOME}"
        if index > 0:
            keys += f"{{DOWN {index}}}"
        keys += "{ENTER}"
        keyboard_target.type_keys(keys)

    @staticmethod
    def _activate_popup_item(item):
        """Commit an exact visible Qt popup item without pointer input."""
        scroll_into_view = getattr(item, "scroll_into_view", None)
        if callable(scroll_into_view):
            try:
                scroll_into_view()
            except Exception:
                pass
        try:
            item.select()
        except Exception:
            pass
        item.set_focus()
        item.type_keys("{ENTER}")

    @staticmethod
    def _click_popup_item_preserving_cursor(item):
        """Qt fallback: click a popup item and immediately restore the cursor."""
        import win32api

        # Prefer a short idle gap so an operator actively moving the pointer is
        # not interrupted.  The bounded wait keeps remote commands responsive.
        previous = win32api.GetCursorPos()
        stable_since = time.monotonic()
        deadline = stable_since + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.05)
            current = win32api.GetCursorPos()
            if current != previous:
                previous = current
                stable_since = time.monotonic()
            elif time.monotonic() - stable_since >= 0.25:
                break

        original = win32api.GetCursorPos()
        try:
            item.click_input()
        finally:
            win32api.SetCursorPos(original)

    def _select_combo_text(
        self,
        combo,
        expected: str,
        error: str,
        fallback_index: int | None = None,
        accepted_aliases: set[str] | None = None,
    ):
        # 이 Qt 목록은 SelectionItem/Invoke 모두 팝업 항목에 표시만 하고
        # QComboBox 값을 확정하지 않는 경우가 있다. 실제 대상 콤보에
        # Home → 항목 순번 → Enter를 보내야 currentIndexChanged가 발생한다.
        target_index: int | None = None
        target_item = None
        all_items = []
        try:
            combo.expand()
            time.sleep(0.15)
            all_items = list(combo.descendants(control_type="ListItem"))
            matching_indices = [
                index
                for index, item in enumerate(all_items)
                if self._control_text(item) == expected
            ]
            if len(matching_indices) == 1:
                target_index = matching_indices[0]
                matching_item = all_items[target_index]
                if callable(getattr(matching_item, "type_keys", None)):
                    target_item = matching_item
            elif fallback_index is not None:
                target_index = fallback_index
            else:
                raise RuntimeError(error)
        except Exception:
            try:
                combo.collapse()
            except Exception:
                pass
            raise
        if target_index is None:
            raise RuntimeError(error)
        try:
            if target_item is not None:
                self._activate_popup_item(target_item)
                method = "ExactPopupItemFocus+Enter"
            else:
                self._keyboard_select_index(combo, target_index, all_items)
                method = f"PopupFocus+KeyboardIndex({target_index})+Enter"
            try:
                self._wait_combo_selection(
                    combo, expected, error, method, accepted_aliases
                )
            except RuntimeError:
                # Qt5's B1 popup sometimes exposes SelectionItem and focus but
                # ignores both activation paths.  Reopen it, locate the exact
                # named item, then use the only reliable Qt fallback.  Cursor
                # restoration limits interference with an operator's mouse.
                combo.expand()
                time.sleep(0.15)
                refreshed_items = list(combo.descendants(control_type="ListItem"))
                refreshed = [
                    item
                    for item in refreshed_items
                    if self._control_text(item) == expected
                ]
                if len(refreshed) == 1:
                    fallback_item = refreshed[0]
                elif 0 <= target_index < len(refreshed_items):
                    # Qt가 팝업의 텍스트를 순간적으로 비우는 경우에도 관리자
                    # 프로그램의 고정된 맵 순번으로 마지막 한 번만 보완한다.
                    fallback_item = refreshed_items[target_index]
                    logging.warning(
                        "Qt 콤보 텍스트가 비어 순번 보완 사용(%s): %s",
                        target_index,
                        expected,
                    )
                else:
                    raise
                logging.warning("Qt 콤보 클릭 보완 사용: %s", expected)
                self._click_popup_item_preserving_cursor(fallback_item)
                self._wait_combo_selection(
                    combo,
                    expected,
                    error,
                    "CursorPreservedPopupClick",
                    accepted_aliases,
                )
        finally:
            try:
                combo.collapse()
            except Exception:
                pass

    @staticmethod
    def _invoke_control(control, error: str):
        try:
            control.invoke()
            return
        except Exception as exc:
            click = getattr(control, "click", None)
            if click is not None:
                try:
                    # Win32 click은 WM_* 메시지를 보내며 실제 포인터는 이동하지 않는다.
                    click()
                    return
                except Exception:
                    pass
            raise RuntimeError(error) from exc

    def room_status(self, room_id: str, window=None) -> str:
        target = window or self._window()
        text = self._control_text(self._control(target, room_id, "status"))
        return "running" if "게임중" in text.replace(" ", "") else "waiting"

    @staticmethod
    def _normalize_map_name(room_id: str, selected_map_name: str) -> str:
        # Keep the manager's exact mode prefix.  B1 genuinely supports both
        # 대형 and 중형 map sets, so normalizing one to the other loses state.
        return selected_map_name

    def read_rooms(
        self, perf_trace: ControlLatencyTrace | None = None
    ) -> dict[str, RoomState]:
        total_started = time.perf_counter()
        try:
            window = self._window(perf_trace) if perf_trace is not None else self._window()
        except Exception as exc:
            raise ManagerStateUnavailableError(
                "관리자 프로그램 창을 확인하지 못했습니다."
            ) from exc
        controls_started = time.perf_counter()
        self._geometry(window)
        self._validate_room_order(window)
        controls = {
            name: self._controls(window, name)
            for name in (
                "status",
                "map",
                "team",
                "people",
                "remaining",
                "score",
                "level",
            )
        }
        if perf_trace is not None:
            perf_trace.mark(
                "MANAGER_CONTROLS_ENUMERATION",
                duration_ms=(time.perf_counter() - controls_started) * 1000,
            )
        parse_started = time.perf_counter()
        result: dict[str, RoomState] = {}
        for room_id in ROOM_NAMES:
            index = int(room_id)
            map_combo = controls["map"][index]
            status_text = self._control_text(controls["status"][index])
            status = (
                "running" if "게임중" in status_text.replace(" ", "") else "waiting"
            )
            self._ensure_map_options(room_id, map_combo, status)

            selected_map_name = self._normalize_map_name(
                room_id, self._selected_text(map_combo)
            )
            current_options = self._map_options.get(room_id, [])
            selected_map_index = (
                current_options.index(selected_map_name) + 1
                if selected_map_name in current_options
                else 0
            )
            selected_people = self._people_index(
                self._selected_text(controls["people"][index])
            )

            remaining_text = self._control_text(controls["remaining"][index])
            remaining_match = re.fullmatch(
                r"\s*(\d+):(\d{1,2})\s*",
                remaining_text,
            )
            if status == "running" and remaining_match is None:
                raise RuntimeError(
                    f"{ROOM_NAMES[room_id][0]} 남은시간({remaining_text or '빈 값'})을 읽지 못했습니다."
                )
            remaining = (
                int(remaining_match.group(1)) * 60 + int(remaining_match.group(2))
                if remaining_match
                else 0
            )
            score_text = self._control_text(controls["score"][index])
            try:
                score = max(0, int(score_text))
            except ValueError:
                score = 0

            result[room_id] = RoomState(
                roomId=room_id,
                status=status,
                teamName=self._control_text(controls["team"][index])[:10],
                mapName=selected_map_name,
                mapIndex=selected_map_index,
                mapOptions=current_options,
                people=max(0, min(10, selected_people)),
                remainingSeconds=remaining if status == "running" else 0,
                score=score,
                level=self._control_text(controls["level"][index])[:80],
            )

        for room_id, room in result.items():
            options = self._map_options.get(room_id, [])
            room.mapOptions = options
            if room.mapName in options:
                room.mapIndex = options.index(room.mapName) + 1
        if perf_trace is not None:
            perf_trace.mark(
                "MANAGER_STATE_PARSE",
                duration_ms=(time.perf_counter() - parse_started) * 1000,
            )
            perf_trace.mark(
                "MANAGER_STATE_READ_TOTAL",
                duration_ms=(time.perf_counter() - total_started) * 1000,
            )
        return result

    @staticmethod
    def _geometry(window) -> tuple[int, int, int, int]:
        rect = window.rectangle()
        width = rect.width()
        height = rect.height()
        ratio = width / max(1, height)
        if width < 380 or height < 850 or not 0.36 <= ratio <= 0.52:
            raise RuntimeError(
                f"관리자 창 크기가 안전 범위를 벗어났습니다. 현재 {width}×{height}"
            )
        return rect.left, rect.top, width, height

    def diagnose(self) -> dict[str, Any]:
        window = self._window()
        left, top, width, height = self._geometry(window)
        self._validate_room_order(window)
        for name in ROOM_CONTROL_IDS:
            self._controls(window, name)
        if self.info_api_enabled:
            self.info_api.probe()
        return {
            "title": window.window_text(),
            "left": left,
            "top": top,
            "width": width,
            "height": height,
            "infoInputMode": "manager-mqtt-api" if self.info_api_enabled else "uia",
            "safe": True,
        }

    def has_active_modal(self) -> bool:
        """Detect a Manager QMessageBox/alert without focusing or clicking it."""

        from pywinauto import Desktop

        window = self._window()
        process_id = int(window.element_info.process_id)
        main_handle = int(getattr(window, "handle", 0) or 0)
        seen_handles: set[int] = set()
        for backend in ("uia", "win32"):
            for candidate in Desktop(backend=backend).windows(process=process_id):
                try:
                    handle = int(getattr(candidate, "handle", 0) or 0)
                    if handle and (handle == main_handle or handle in seen_handles):
                        continue
                    if handle:
                        seen_handles.add(handle)
                    title = str(candidate.window_text() or "").strip()
                    element_info = getattr(candidate, "element_info", None)
                    class_name = str(
                        getattr(element_info, "class_name", "") or ""
                    ).strip()
                    if class_name == "QMessageBox" or title == "알림":
                        return True
                except Exception:
                    continue
        return False

    def _set_room_info_api(
        self,
        window,
        room_id: str,
        team_name: str,
        map_index: int,
        people: int,
        skip_people: bool = False,
        perf_trace: ControlLatencyTrace | None = None,
    ):
        _, controls = self._bounded_room_controls(
            room_id,
            ("status", "team", "map", "people", "info"),
            initial_window=window,
        )
        status_readable, status_text = self._control_text_result(controls["status"])
        if not status_readable or not status_text.strip():
            raise RoomStateReadError(
                "해당 방의 최신 실행 상태를 읽지 못했습니다."
            )
        if "게임중" in status_text.replace(" ", ""):
            raise SetInfoRoomBusyError(
                "이미 게임 중이라 팀명과 맵을 변경하지 않았습니다."
            )
        team_control = controls["team"]
        map_control = controls["map"]
        people_control = controls["people"]

        target_team = team_name[:10] if team_name else self._control_text(team_control)[:10]
        if map_index > 0:
            options = self._map_options_for_write(room_id)
            if map_index > len(options):
                raise InfoApiUnsupported(
                    f"선택한 맵 번호 {map_index}가 현재 목록 범위({len(options)})를 벗어났습니다."
                )
            target_map = options[map_index - 1]
        else:
            target_map = self._normalize_map_name(
                room_id, self._selected_text(map_control)
            )

        # The manager's companion-app MQTT handler searches B1's primary
        # (large) map_data only.  Medium-mode maps live in map_data2 and cannot
        # be selected through that handler, so go straight to the precise Qt
        # index path instead of waiting for an API timeout first.
        if room_id == "2" and target_map.startswith("중형-"):
            raise InfoApiUnsupported(
                "B1 중형 모드는 관리자 내부 API가 지원하지 않아 정확한 콤보 인덱스로 처리합니다."
            )

        current_team = self._control_text(team_control)
        current_map = self._normalize_map_name(
            room_id, self._selected_text(map_control)
        )
        # Validate before opening the manager's short companion-app receive
        # window. Unsupported/new maps must fall back without emitting a QR
        # information request that could race with an actual companion app.
        if target_map not in MAP_SERIALS:
            raise InfoApiUnsupported(
                f"{target_map or '현재 맵'}은 관리자 내부 API 번호가 없어 기존 방식으로 처리합니다."
            )
        if not target_team:
            raise InfoApiUnsupported(
                "현재 팀명이 비어 있어 내부 API 대신 기존 방식으로 처리합니다."
            )

        people_readable, people_text = self._selected_text_result(people_control)
        current_people = self._people_index(people_text) if people_readable else 0
        if skip_people:
            if current_people <= 0:
                raise RoomStateReadError(
                    "인원 유지에 필요한 해당 방의 최신 인원 값을 읽지 못했습니다."
                )
            target_people = current_people
        else:
            target_people = people or current_people
        expected_people = "기타" if target_people == 10 else f"{target_people}명"

        if (
            skip_people
            and self._normalize_team_for_compare(current_team)
            == self._normalize_team_for_compare(target_team)
            and current_map == target_map
        ):
            if perf_trace is not None:
                perf_trace.mark(
                    "MANAGER_RESPONSE_ACK",
                    duration_ms=0,
                    details={"method": "already-matched"},
                )
            logging.info(
                "%s 정보가 이미 일치해 입력 생략: 팀명길이=%d, 맵=%s",
                ROOM_NAMES[room_id][0],
                len(target_team),
                target_map,
            )
            return

        prepare_started = time.perf_counter()
        self._invoke_control(
            controls["info"],
            "관리자 내부 정보 입력 대기 버튼을 실행하지 못했습니다.",
        )
        # 관리자 프로그램이 MQTT 수신 창을 여는 데 아주 짧은 준비 시간이
        # 필요하다. 즉시 발행할 때 간헐적으로 첫 메시지가 유실되던 경합을 막는다.
        time.sleep(0.08)
        if perf_trace is not None:
            perf_trace.mark(
                "MANAGER_RECEIVE_WINDOW_PREPARE",
                duration_ms=(time.perf_counter() - prepare_started) * 1000,
            )
        send_started = time.perf_counter()
        if perf_trace is not None:
            perf_trace.mark(
                "MANAGER_SEND_START",
                details={
                    "room": room_id,
                    "mapIndex": map_index,
                    "skipPeople": skip_people,
                    "teamLength": len(target_team),
                },
            )
        try:
            if perf_trace is None:
                map_serial = self.info_api.send(
                    room_id, target_map, target_team, target_people
                )
            else:
                map_serial = self.info_api.send(
                    room_id,
                    target_map,
                    target_team,
                    target_people,
                    perf_trace,
                )
        except Exception as exc:
            if perf_trace is not None:
                perf_trace.mark(
                    "MANAGER_SEND_FAILED",
                    duration_ms=(time.perf_counter() - send_started) * 1000,
                    details={"errorType": type(exc).__name__},
                )
            raise ManagerTransportError(
                "관리자 내부 API로 정보 입력 요청을 전송하지 못했습니다."
            ) from exc
        if perf_trace is not None:
            perf_trace.mark(
                "MANAGER_SEND_DONE",
                duration_ms=(time.perf_counter() - send_started) * 1000,
                details={"mapSerial": map_serial},
            )

        self._verify_set_info_applied(
            room_id,
            target_team,
            target_map,
            map_index,
            expected_people,
            skip_people,
            perf_trace,
        )
        logging.info(
            "%s 정보 입력 완료(관리자 내부 API): 팀명길이=%d, 맵=%s, 인원=%s",
            ROOM_NAMES[room_id][0],
            len(target_team),
            target_map,
            "유지" if skip_people else target_people,
        )

    def _set_room_info_uia(
        self,
        room_id: str,
        team_name: str,
        map_index: int,
        people: int,
        skip_people: bool = False,
        window=None,
    ):
        names = ("status", "team", "map") if skip_people else (
            "status",
            "team",
            "map",
            "people",
        )
        target_window, controls = self._bounded_room_controls(
            room_id, names, initial_window=window
        )
        if "게임중" in self._control_text(controls["status"]).replace(" ", ""):
            raise RuntimeError("이미 게임 중이라 팀명과 맵을 변경하지 않았습니다.")

        if team_name:
            edit = controls["team"]
            expected_team = team_name[:10]
            if self._control_text(edit) != expected_team:
                edit.set_edit_text(expected_team)
                self._wait_control_text(
                    edit,
                    expected_team,
                    "팀명이 정확히 입력되지 않아 시작하지 않았습니다.",
                )

        if map_index > 0:
            combo = controls["map"]
            options = self._map_options_for_write(room_id)
            if map_index > len(options):
                raise RuntimeError(
                    f"선택한 맵 번호 {map_index}가 현재 목록 범위({len(options)})를 벗어났습니다."
                )
            expected_map = options[map_index - 1]
            current_map = self._normalize_map_name(
                room_id, self._selected_text(combo)
            )
            if current_map == expected_map:
                logging.info("맵이 이미 반영되어 콤보 재입력 생략: %s", expected_map)
            else:
                self._select_combo_text(
                    combo,
                    expected_map,
                    "맵 선택 결과를 확인하지 못해 시작하지 않았습니다.",
                    fallback_index=self._map_combo_index(room_id, map_index),
                )

        if not skip_people and people > 0:
            combo = controls["people"]
            expected = "기타" if people == 10 else f"{people}명"
            self._select_combo_text(
                combo,
                expected,
                "인원 선택 결과를 확인하지 못해 시작하지 않았습니다.",
            )

    def set_room_info(
        self,
        room_id: str,
        team_name: str,
        map_index: int,
        people: int,
        skip_people: bool = False,
        perf_trace: ControlLatencyTrace | None = None,
    ):
        total_started = time.perf_counter()
        try:
            window = self._window(perf_trace) if perf_trace is not None else self._window()
        except Exception as exc:
            raise ManagerStateUnavailableError(
                "관리자 프로그램 창을 확인하지 못했습니다."
            ) from exc

        fallback_reason = "manager-api-disabled"
        if self.info_api_enabled:
            try:
                self._set_room_info_api(
                    window,
                    room_id,
                    team_name,
                    map_index,
                    people,
                    skip_people,
                    perf_trace,
                )
                if perf_trace is not None:
                    perf_trace.mark(
                        "MANAGER_SET_INFO_TOTAL",
                        duration_ms=(time.perf_counter() - total_started) * 1000,
                        details={"path": "mqtt"},
                )
                return
            except SetInfoVerificationError as exc:
                if exc.error_code == "STATE_READ_FAILED":
                    raise
                fallback_reason = exc.error_code
                logging.warning(
                    "%s 내부 API 반영 불일치가 bounded polling 동안 지속되어 UIA 보완을 결정: %s",
                    ROOM_NAMES[room_id][0],
                    exc.error_code,
                )
            except InfoApiUnsupported as exc:
                fallback_reason = "manager-api-input-unsupported"
                logging.info(
                    "%s 내부 API 미지원 입력만 정확한 UI 방식으로 처리: %s",
                    ROOM_NAMES[room_id][0],
                    exc,
                )
            except ControlCommandError:
                raise
            except Exception as exc:
                raise ManagerTransportError(
                    "관리자 내부 API 입력에 실패했습니다. 안전을 위해 화면 입력으로 자동 전환하지 않았습니다."
                ) from exc

        if perf_trace is not None:
            perf_trace.mark(
                "UIA_FALLBACK_DECIDED",
                details={"reason": fallback_reason},
            )
            perf_trace.mark("UIA_FALLBACK_START")
        try:
            window, verification_controls = self._bounded_room_controls(
                room_id,
                ("team", "map", "people"),
                initial_window=window,
            )
            verification_team = (
                team_name[:10]
                if team_name
                else self._control_text(verification_controls["team"])[:10]
            )
            if map_index > 0:
                map_options = self._map_options_for_write(room_id)
                if map_index > len(map_options):
                    raise InfoApiUnsupported(
                        f"선택한 맵 번호 {map_index}가 현재 목록 범위({len(map_options)})를 벗어났습니다."
                    )
                verification_map = map_options[map_index - 1]
            else:
                verification_map = self._normalize_map_name(
                    room_id, self._selected_text(verification_controls["map"])
                )
            verification_people = (
                self._selected_text(verification_controls["people"])
                if skip_people
                else "기타" if people == 10 else f"{people}명"
            )
        except InfoApiUnsupported as exc:
            raise RoomControlError(
                str(exc),
                error_code="SET_INFO_INPUT_UNSUPPORTED",
                room_control_state="SET_INFO_FAILED",
            ) from exc
        except ControlCommandError:
            raise
        except Exception as exc:
            raise RoomStateReadError(
                "관리자 화면 입력 전 최신 방 상태를 확인하지 못했습니다."
            ) from exc
        fallback_started = time.perf_counter()
        try:
            self._set_room_info_uia(
                room_id,
                team_name,
                map_index,
                people,
                skip_people,
                window,
            )
        except ControlCommandError:
            raise
        except Exception as exc:
            if perf_trace is not None:
                perf_trace.mark(
                    "UIA_FALLBACK_DONE",
                    duration_ms=(time.perf_counter() - fallback_started) * 1000,
                    details={"result": "failed", "errorType": type(exc).__name__},
                )
            raise UiaFallbackError(
                "관리자 화면 입력 방식으로 팀명·맵을 반영하지 못했습니다."
            ) from exc
        if perf_trace is not None:
            perf_trace.mark(
                "UIA_FALLBACK_DONE",
                duration_ms=(time.perf_counter() - fallback_started) * 1000,
                details={"result": "completed"},
            )
        self._verify_set_info_applied(
            room_id,
            verification_team,
            verification_map,
            map_index,
            verification_people,
            skip_people,
            perf_trace,
        )
        if perf_trace is not None:
            perf_trace.mark(
                "MANAGER_SET_INFO_TOTAL",
                duration_ms=(time.perf_counter() - total_started) * 1000,
                details={"path": "uia-fallback"},
            )

    def start(
        self, room_id: str, perf_trace: ControlLatencyTrace | None = None
    ):
        try:
            return self._start_room(room_id, perf_trace)
        except ControlCommandError:
            raise
        except Exception as exc:
            raise RoomControlError(
                str(exc),
                error_code="START_FAILED",
                room_control_state="CONTROL_FAILED",
            ) from exc

    def _start_room(
        self, room_id: str, perf_trace: ControlLatencyTrace | None = None
    ):
        total_started = time.perf_counter()
        try:
            window = self._window(perf_trace) if perf_trace is not None else self._window()
        except Exception as exc:
            raise ManagerStateUnavailableError(
                "관리자 프로그램 창을 확인하지 못했습니다."
            ) from exc
        status_control = self._control(window, room_id, "status")
        status_readable, status_text = self._control_text_result(status_control)
        if not status_readable or not status_text.strip():
            raise RoomStateReadError(
                "게임 시작 전 해당 방의 최신 실행 상태를 읽지 못했습니다."
            )
        if "게임중" in status_text.replace(" ", ""):
            raise RuntimeError("이미 게임 중이라 시작 버튼을 다시 누르지 않았습니다.")
        self._invoke_control(
            self._control(window, room_id, "play"),
            "시작 버튼을 마우스 없이 실행하지 못했습니다.",
        )
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            status_readable, status_text = self._control_text_result(status_control)
            if not status_readable or not status_text.strip():
                raise RoomStateReadError(
                    "게임 시작 후 해당 방의 최신 실행 상태를 읽지 못했습니다."
                )
            if "게임중" in status_text.replace(" ", ""):
                if perf_trace is not None:
                    perf_trace.mark(
                        "MANAGER_START_ACK",
                        duration_ms=(time.perf_counter() - total_started) * 1000,
                    )
                return
            time.sleep(0.15)
        raise RuntimeError("시작 버튼을 눌렀지만 게임 중 상태로 바뀌지 않았습니다.")

    @staticmethod
    def _verified_stop_button(dialog):
        try:
            if dialog.window_text().strip() != "알림":
                return None
            if dialog.element_info.class_name != "QMessageBox":
                return None
            messages = {
                item.window_text().strip()
                for item in dialog.descendants(control_type="Text")
            }
            if "정말 정지 할까요?" not in messages:
                return None
            buttons = dialog.descendants(control_type="Button")
            positive = [
                button for button in buttons if button.window_text().strip() == "예"
            ]
            negative = [
                button for button in buttons if button.window_text().strip() == "취소"
            ]
            if len(positive) == 1 and len(negative) == 1:
                return positive[0]
        except Exception:
            return None
        return None

    @staticmethod
    def _control_stage(
        stage: str,
        command_id: str,
        started_at: float,
        perf_trace: ControlLatencyTrace | None = None,
        **details: Any,
    ):
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        logging.info(
            "[CONTROL RELIABILITY] stage=%s command_id=%s elapsed_ms=%.3f thread=%s process=%d details=%s",
            stage,
            command_id or "-",
            elapsed_ms,
            threading.current_thread().name,
            os.getpid(),
            json.dumps(details, ensure_ascii=False, separators=(",", ":")),
        )
        if perf_trace is not None:
            perf_trace.mark(stage, duration_ms=elapsed_ms, details=details)

    @staticmethod
    def _initialize_automation_thread():
        """Initialize COM inside each independent UI Automation worker."""
        try:
            import pythoncom

            pythoncom.CoInitialize()
            return pythoncom.CoUninitialize
        except ImportError:
            try:
                import comtypes

                comtypes.CoInitialize()
                return comtypes.CoUninitialize
            except Exception:
                return lambda: None

    def _process_window(self, process_id: int, window_handle: int):
        from pywinauto import Desktop

        desktop = Desktop(backend="uia")
        if window_handle:
            try:
                window = desktop.window(handle=window_handle)
                if self.title in window.window_text():
                    return window
            except Exception:
                pass
        candidates = []
        for window in desktop.windows(process=process_id):
            try:
                if self.title in window.window_text():
                    candidates.append(window)
            except Exception:
                continue
        if len(candidates) != 1:
            raise RuntimeError("정지할 관리자 창을 안전하게 다시 연결하지 못했습니다.")
        return candidates[0]

    def _trigger_stop_control(
        self,
        process_id: int,
        window_handle: int,
        room_id: str,
        command_id: str,
        started_at: float,
        finished: threading.Event,
        errors: list[Exception],
        perf_trace: ControlLatencyTrace | None,
    ):
        uninitialize = self._initialize_automation_thread()
        try:
            window = self._process_window(process_id, window_handle)
            self._invoke_control(
                self._control(window, room_id, "stop"),
                "정지 버튼을 마우스 없이 실행하지 못했습니다.",
            )
        except Exception as exc:
            errors.append(exc)
        finally:
            finished.set()
            self._control_stage(
                "STOP_TRIGGER_RETURNED",
                command_id,
                started_at,
                perf_trace,
                success=not errors,
            )
            try:
                uninitialize()
            except Exception:
                pass

    def _watch_stop_dialog(
        self,
        process_id: int,
        window_handle: int,
        command_id: str,
        started_at: float,
        cancel: threading.Event,
        confirmed: threading.Event,
        errors: list[Exception],
        perf_trace: ControlLatencyTrace | None,
    ):
        uninitialize = self._initialize_automation_thread()
        from pywinauto import Desktop

        self._control_stage(
            "STOP_DIALOG_SEARCH_BEGIN", command_id, started_at, perf_trace
        )
        deadline = time.monotonic() + STOP_DIALOG_TIMEOUT_SECONDS
        manager_window = None
        try:
            while not cancel.is_set() and time.monotonic() < deadline:
                candidates = []
                if manager_window is None:
                    try:
                        manager_window = self._process_window(
                            process_id, window_handle
                        )
                    except Exception:
                        manager_window = None
                if manager_window is not None:
                    try:
                        candidates.extend(
                            manager_window.descendants(control_type="Window")
                        )
                    except Exception:
                        manager_window = None
                for backend in ("uia", "win32"):
                    try:
                        candidates.extend(
                            Desktop(backend=backend).windows(process=process_id)
                        )
                    except Exception:
                        continue
                for dialog in candidates:
                    button = self._verified_stop_button(dialog)
                    if button is None or cancel.is_set():
                        continue
                    self._control_stage(
                        "STOP_DIALOG_FOUND", command_id, started_at, perf_trace
                    )
                    self._invoke_control(
                        button,
                        "정지 확인 버튼을 마우스 없이 실행하지 못했습니다.",
                    )
                    confirmed.set()
                    self._control_stage(
                        "STOP_CONFIRM_CLICKED", command_id, started_at, perf_trace
                    )
                    closed_deadline = time.monotonic() + 1.0
                    while time.monotonic() < closed_deadline:
                        exists = getattr(dialog, "exists", None)
                        if exists is None:
                            break
                        try:
                            if not exists(timeout=0):
                                break
                        except Exception:
                            break
                        time.sleep(STOP_POLL_SECONDS)
                    self._control_stage(
                        "STOP_DIALOG_CLOSED", command_id, started_at, perf_trace
                    )
                    return
                cancel.wait(STOP_POLL_SECONDS)
        except Exception as exc:
            errors.append(exc)
        finally:
            try:
                uninitialize()
            except Exception:
                pass

    def stop(
        self, room_id: str, perf_trace: ControlLatencyTrace | None = None
    ):
        try:
            return self._stop_room(room_id, perf_trace)
        except ControlCommandError:
            raise
        except Exception as exc:
            raise RoomControlError(
                str(exc),
                error_code="STOP_FAILED",
                room_control_state="CONTROL_FAILED",
            ) from exc

    def _stop_room(
        self, room_id: str, perf_trace: ControlLatencyTrace | None = None
    ):
        total_started = time.perf_counter()
        command_id = perf_trace.trace_id if perf_trace is not None else ""
        try:
            window = self._window(perf_trace) if perf_trace is not None else self._window()
        except Exception as exc:
            raise ManagerStateUnavailableError(
                "관리자 프로그램 창을 확인하지 못했습니다."
            ) from exc
        status_control = self._control(window, room_id, "status")
        status_readable, status_text = self._control_text_result(status_control)
        if not status_readable or not status_text.strip():
            raise RoomStateReadError(
                "게임 정지 전 해당 방의 최신 실행 상태를 읽지 못했습니다."
            )
        if "게임중" not in status_text.replace(" ", ""):
            return
        process_id = window.element_info.process_id
        window_handle = int(getattr(window, "handle", 0) or 0)
        trigger_finished = threading.Event()
        dialog_confirmed = threading.Event()
        cancel_watcher = threading.Event()
        trigger_errors: list[Exception] = []
        watcher_errors: list[Exception] = []

        self._control_stage(
            "STOP_TRIGGER_BEGIN", command_id, total_started, perf_trace
        )
        watcher = threading.Thread(
            target=self._watch_stop_dialog,
            args=(
                process_id,
                window_handle,
                command_id,
                total_started,
                cancel_watcher,
                dialog_confirmed,
                watcher_errors,
                perf_trace,
            ),
            name=f"stop-modal-watcher-{room_id}",
            daemon=True,
        )
        trigger = threading.Thread(
            target=self._trigger_stop_control,
            args=(
                process_id,
                window_handle,
                room_id,
                command_id,
                total_started,
                trigger_finished,
                trigger_errors,
                perf_trace,
            ),
            name=f"stop-trigger-{room_id}",
            daemon=True,
        )
        watcher.start()
        trigger.start()

        dialog_deadline = time.monotonic() + STOP_DIALOG_TIMEOUT_SECONDS
        while time.monotonic() < dialog_deadline:
            if dialog_confirmed.wait(STOP_POLL_SECONDS):
                break
            if trigger_finished.is_set() and trigger_errors:
                break

        if not dialog_confirmed.is_set():
            cancel_watcher.set()
            self._control_stage(
                "STOP_TIMEOUT",
                command_id,
                total_started,
                perf_trace,
                triggerFinished=trigger_finished.is_set(),
                triggerError=type(trigger_errors[0]).__name__ if trigger_errors else "",
                watcherError=type(watcher_errors[0]).__name__ if watcher_errors else "",
            )
            if trigger_errors:
                raise RuntimeError(
                    "정지 버튼 실행에 실패했습니다. 관리자 프로그램을 확인해 주세요."
                ) from trigger_errors[0]
            if watcher_errors:
                raise RuntimeError(
                    "정지 확인창 처리에 실패했습니다. 관리자 프로그램을 확인해 주세요."
                ) from watcher_errors[0]
            raise RuntimeError(
                "정지 확인이 필요합니다. 확인창을 자동 처리하지 못했습니다."
            )

        cancel_watcher.set()
        status_deadline = time.monotonic() + STOP_STATUS_TIMEOUT_SECONDS
        while time.monotonic() < status_deadline:
            status_readable, status_text = self._control_text_result(status_control)
            if not status_readable or not status_text.strip():
                raise RoomStateReadError(
                    "게임 정지 후 해당 방의 최신 실행 상태를 읽지 못했습니다."
                )
            if "게임중" not in status_text.replace(" ", ""):
                self._control_stage(
                    "STOP_COMPLETED", command_id, total_started, perf_trace
                )
                if perf_trace is not None:
                    perf_trace.mark(
                        "MANAGER_STOP_ACK",
                        duration_ms=(time.perf_counter() - total_started) * 1000,
                    )
                return
            time.sleep(STOP_POLL_SECONDS)
        self._control_stage(
            "STOP_TIMEOUT",
            command_id,
            total_started,
            perf_trace,
            reason="status-not-updated",
        )
        raise RuntimeError("정지 확인 후에도 대기 상태로 바뀌지 않았습니다.")


def manager_ui_from_config(config: BridgeConfig) -> ManagerUI:
    return ManagerUI(
        config.manager_title,
        info_api_enabled=config.info_api_enabled,
        info_api=ManagerInfoApi(
            LocalMqttPublisher(
                host=config.manager_mqtt_host,
                port=config.manager_mqtt_port,
                username=config.manager_mqtt_username,
                password=config.manager_mqtt_password,
            )
        ),
    )


class RemoteTransportError(RuntimeError):
    """Temporary HTTPS failure that the bridge can safely retry."""


class RemoteResponseError(RuntimeError):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        super().__init__(f"서버 응답 오류 {status}: {detail[:250]}")


class RemoteClient:
    def __init__(self, config: BridgeConfig):
        self.base_url = config.server_url.rstrip("/")
        self.token = config.agent_token
        parsed = urllib.parse.urlsplit(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise RuntimeError("원격 서버 주소가 올바르지 않습니다.")
        self.scheme = parsed.scheme
        self.host = parsed.hostname
        self.port = parsed.port
        self.base_path = parsed.path.rstrip("/")
        self._connection: http.client.HTTPConnection | None = None
        self._connection_lock = threading.Lock()

    def _new_connection(self) -> http.client.HTTPConnection:
        connection_type = (
            http.client.HTTPSConnection
            if self.scheme == "https"
            else http.client.HTTPConnection
        )
        return connection_type(
            self.host,
            port=self.port,
            timeout=REMOTE_REQUEST_TIMEOUT,
        )

    def _close_connection(self):
        connection, self._connection = self._connection, None
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass

    def _post_once(
        self,
        path: str,
        body: bytes,
        perf_trace: ControlLatencyTrace | None = None,
    ) -> dict[str, Any]:
        connection_reused = self._connection is not None
        if self._connection is None:
            create_started = time.perf_counter()
            self._connection = self._new_connection()
            if perf_trace is not None:
                perf_trace.mark(
                    "BRIDGE_CONNECTION_OBJECT_CREATE",
                    duration_ms=(time.perf_counter() - create_started) * 1000,
                )
        request_path = f"{self.base_path}{path}" or "/"
        try:
            send_started = time.perf_counter()
            self._connection.request(
                "POST",
                request_path,
                body=body,
                headers={
                    "content-type": "application/json",
                    "accept": "application/json",
                    "x-jumping-agent-token": self.token,
                    "user-agent": f"JumpingBattleBridge/{VERSION}",
                    "connection": "keep-alive",
                },
            )
            if perf_trace is not None:
                perf_trace.mark(
                    "BRIDGE_HTTP_REQUEST_SENT",
                    duration_ms=(time.perf_counter() - send_started) * 1000,
                    details={
                        "path": path,
                        "bytes": len(body),
                        "connectionReused": connection_reused,
                    },
                )
            response_wait_started = time.perf_counter()
            response = self._connection.getresponse()
            if perf_trace is not None:
                perf_trace.mark(
                    "BRIDGE_HTTP_RESPONSE_HEADERS",
                    duration_ms=(time.perf_counter() - response_wait_started) * 1000,
                    details={"status": response.status},
                )
            response_read_started = time.perf_counter()
            response_body = response.read()
            if perf_trace is not None:
                perf_trace.mark(
                    "BRIDGE_HTTP_RESPONSE_BODY",
                    duration_ms=(time.perf_counter() - response_read_started) * 1000,
                    details={"bytes": len(response_body)},
                )
        except (
            TimeoutError,
            socket.timeout,
            ConnectionError,
            http.client.HTTPException,
            OSError,
        ):
            self._close_connection()
            raise

        if response.will_close:
            self._close_connection()
        parse_started = time.perf_counter()
        detail = response_body.decode("utf-8", errors="replace")
        if response.status >= 400:
            raise RemoteResponseError(response.status, detail)
        try:
            result = json.loads(detail)
        except json.JSONDecodeError as exc:
            self._close_connection()
            raise RemoteTransportError("서버가 올바르지 않은 응답을 보냈습니다.") from exc
        if not isinstance(result, dict):
            raise RemoteTransportError("서버 응답 형식이 올바르지 않습니다.")
        if perf_trace is not None:
            perf_trace.mark(
                "BRIDGE_HTTP_RESPONSE_PARSE",
                duration_ms=(time.perf_counter() - parse_started) * 1000,
            )
        return result

    def post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        perf_trace: ControlLatencyTrace | None = None,
    ) -> dict[str, Any]:
        serialize_started = time.perf_counter()
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if perf_trace is not None:
            perf_trace.mark(
                "BRIDGE_REQUEST_SERIALIZE",
                duration_ms=(time.perf_counter() - serialize_started) * 1000,
                details={"path": path, "bytes": len(body)},
            )
        last_error: Exception | None = None
        trace_id = valid_trace_id(payload.get("traceId"))
        lock_started = time.perf_counter()
        self._connection_lock.acquire()
        if perf_trace is not None:
            perf_trace.mark(
                "BRIDGE_HTTP_LOCK_WAIT",
                duration_ms=(time.perf_counter() - lock_started) * 1000,
                details={"path": path},
            )
        try:
            for attempt in range(REMOTE_REQUEST_ATTEMPTS):
                attempt_started = time.perf_counter()
                reused_connection = self._connection is not None
                try:
                    response = self._post_once(path, body, perf_trace)
                    logging.info(
                        "[HTTP TRACE] trace=%s path=%s attempt=%d result=ok elapsed_ms=%.3f connection_reused=%s",
                        trace_id or "-",
                        path,
                        attempt + 1,
                        (time.perf_counter() - attempt_started) * 1000,
                        reused_connection,
                    )
                    return response
                except RemoteResponseError as exc:
                    if exc.status < 500:
                        raise
                    last_error = exc
                    self._close_connection()
                except RemoteTransportError as exc:
                    last_error = exc
                except (
                    TimeoutError,
                    socket.timeout,
                    ConnectionError,
                    http.client.HTTPException,
                    OSError,
                ) as exc:
                    last_error = exc
                logging.warning(
                    "[HTTP TRACE] trace=%s path=%s attempt=%d result=error elapsed_ms=%.3f error=%s",
                    trace_id or "-",
                    path,
                    attempt + 1,
                    (time.perf_counter() - attempt_started) * 1000,
                    type(last_error).__name__ if last_error is not None else "unknown",
                )
                if attempt + 1 < REMOTE_REQUEST_ATTEMPTS:
                    retry_started = time.perf_counter()
                    time.sleep(REMOTE_RETRY_DELAY)
                    if perf_trace is not None:
                        perf_trace.mark(
                            "BRIDGE_HTTP_RETRY_DELAY",
                            duration_ms=(time.perf_counter() - retry_started) * 1000,
                            details={"attempt": attempt + 1},
                        )
            reason = str(last_error) or type(last_error).__name__
            raise RemoteTransportError(
                f"원격 서버 응답 지연({REMOTE_REQUEST_ATTEMPTS}회 재시도): {reason}"
            ) from last_error
        finally:
            self._connection_lock.release()

    def sync(
        self,
        agent_id: str,
        rooms: dict[str, RoomState],
        *,
        armed: bool,
        simulate: bool,
        manager_visible: bool,
        payment_terminal: dict[str, Any],
        perf_trace: ControlLatencyTrace | None = None,
    ) -> list[dict[str, Any]]:
        sync_started = time.perf_counter()
        result = self.post(
            "/api/agent/sync",
            {
                "agentId": agent_id,
                "version": VERSION,
                "armed": armed,
                "simulate": simulate,
                "managerVisible": manager_visible,
                "rooms": [room.public_dict() for room in rooms.values()],
                "paymentTerminal": payment_terminal,
            },
            perf_trace=perf_trace,
        )
        sync_elapsed_ms = (time.perf_counter() - sync_started) * 1000
        commands = result.get("commands", [])
        if not isinstance(commands, list):
            return []
        for command in commands:
            if isinstance(command, dict):
                command["_bridgeSyncRttMs"] = round(sync_elapsed_ms, 3)
        return commands

    def heartbeat(
        self,
        agent_id: str,
        bridge_instance_id: str,
        control_status: dict[str, Any],
    ) -> None:
        self.post(
            "/api/agent/heartbeat",
            {
                "agentId": agent_id,
                "version": VERSION,
                "bridgeInstanceId": bridge_instance_id,
                **control_status,
            },
        )

    def payment_commands(self, agent_id: str) -> list[dict[str, Any]]:
        request_started = time.perf_counter()
        result = self.post(
            "/api/agent/payment-commands",
            {"agentId": agent_id, "version": VERSION},
        )
        elapsed_ms = (time.perf_counter() - request_started) * 1000
        commands = result.get("commands", [])
        if not isinstance(commands, list):
            return []
        for command in commands:
            if isinstance(command, dict):
                command["_bridgeSyncRttMs"] = round(elapsed_ms, 3)
        return commands

    def control_commands(self, agent_id: str) -> list[dict[str, Any]]:
        request_started = time.perf_counter()
        result = self.post(
            "/api/agent/control-commands",
            {"agentId": agent_id, "version": VERSION},
        )
        elapsed_ms = (time.perf_counter() - request_started) * 1000
        commands = result.get("commands", [])
        if not isinstance(commands, list):
            return []
        for command in commands:
            if isinstance(command, dict):
                command["_bridgeSyncRttMs"] = round(elapsed_ms, 3)
        return commands

    def parking_commands(self, agent_id: str) -> list[dict[str, Any]]:
        result = self.post(
            "/api/agent/parking-commands",
            {"agentId": agent_id, "version": VERSION},
        )
        commands = result.get("commands", [])
        return commands if isinstance(commands, list) else []

    def parking_policy(self, agent_id: str) -> bool:
        result = self.post("/api/agent/parking-policy", {"agentId": agent_id})
        return result.get("enabled") is True

    def parking_ack(
        self,
        agent_id: str,
        command_id: str,
        command_status: str,
        result: dict[str, Any],
    ):
        self.post(
            "/api/agent/parking-ack",
            {
                "agentId": agent_id,
                "commandId": command_id,
                "commandStatus": command_status,
                "result": result,
            },
        )

    def local_payment_result(self, payload: dict[str, Any]):
        return self.post("/api/agent/local-payment-result", payload)

    def ack(
        self,
        command_id: str,
        status: str,
        result: str,
        room: RoomState | dict[str, Any] | None = None,
        *,
        trace_id: str = "",
        latency_events: list[dict[str, Any]] | None = None,
        perf_trace: ControlLatencyTrace | None = None,
        error_code: str = "",
        error_scope: str = "",
        room_control_state: str = "",
    ):
        payload: dict[str, Any] = {
            "commandId": command_id,
            "status": status,
            "result": result,
        }
        if isinstance(room, RoomState):
            payload["room"] = room.public_dict()
        elif isinstance(room, dict):
            payload["room"] = dict(room)
        if trace_id:
            payload["traceId"] = trace_id
        if latency_events:
            payload["latencyEvents"] = latency_events[:100]
        if error_code:
            payload["errorCode"] = error_code
        if error_scope:
            payload["errorScope"] = error_scope
        if room_control_state:
            payload["roomControlState"] = room_control_state
        ack_started = time.perf_counter()
        self.post("/api/agent/ack", payload, perf_trace=perf_trace)
        if perf_trace is not None:
            perf_trace.mark(
                "BRIDGE_ACK_ROUND_TRIP",
                duration_ms=(time.perf_counter() - ack_started) * 1000,
            )

    def close(self):
        with self._connection_lock:
            self._close_connection()


class Bridge:
    def __init__(
        self,
        config: BridgeConfig,
        state_path: Path,
        config_path: Path | None = None,
        payment_service: PaymentService | DisabledPaymentService | None = None,
    ):
        self.config = config
        self.config_path = config_path
        self.state = StateStore(state_path)
        self.remote = RemoteClient(config)
        self.heartbeat_remote = RemoteClient(config)
        self.payment_remote = RemoteClient(config)
        self.control_remote = RemoteClient(config)
        self.parking_remote = RemoteClient(config)
        self.local_payment_remote = RemoteClient(config)
        self.ui = manager_ui_from_config(config)
        self.logs = ManagerLogReader(Path(config.manager_dir))
        self.payment = payment_service or (
            PaymentService.from_bridge_config(
                config,
                application_dir=app_dir(),
                runtime_dir=runtime_dir(),
            )
            if config.mpos_enabled and not config.simulate
            else DisabledPaymentService()
        )
        self.parking = ParkingRegistrationService.from_environment(
            state_path.parent / "logs" / "parking_discount.jsonl"
        )
        self.stop_event = threading.Event()
        self._heartbeat_thread: threading.Thread | None = None
        self._payment_thread: threading.Thread | None = None
        self._control_thread: threading.Thread | None = None
        self._parking_thread: threading.Thread | None = None
        self._local_payment_sync_thread: threading.Thread | None = None
        self.local_payment_runtime: LocalPaymentRuntime | None = None
        self.local_payment_server: LocalPaymentHttpServer | None = None
        if config.local_payment_enabled:
            parsed_server = urllib.parse.urlsplit(config.server_url)
            server_origin = (
                f"{parsed_server.scheme}://{parsed_server.netloc}"
                if parsed_server.scheme and parsed_server.netloc
                else ""
            )
            allowed_origins = {server_origin}
            allowed_origins.update(
                str(origin).rstrip("/")
                for origin in config.local_payment_allowed_origins
                if str(origin).strip()
            )
            self.local_payment_runtime = LocalPaymentRuntime(
                secret=config.agent_token,
                allowed_origins=allowed_origins,
                store=LocalPaymentStore(
                    runtime_dir() / "payments" / "local_direct_v2.db"
                ),
                payment_service=self.payment,
                sync_result=self.local_payment_remote.local_payment_result,
            )
            self.local_payment_server = LocalPaymentHttpServer(
                config.local_payment_host,
                int(config.local_payment_port),
                self.local_payment_runtime,
            )
        self._manager_io_lock = threading.Lock()
        self._ack_delivery_lock = threading.Lock()
        self._control_status_lock = threading.Lock()
        self._bridge_instance_id = uuid.uuid4().hex
        self._control_state = "IDLE"
        self._current_control_action = ""
        self._control_started_at = ""
        self._last_control_success_at = ""
        self._last_control_error = ""
        self._active_control_command_id = ""
        self._active_control_room_id = ""
        self._claimed_control_command_ids: set[str] = set()
        self._room_control_errors: dict[str, dict[str, Any]] = {}
        self._room_control_last_success_at: dict[str, str] = {}
        self._control_recovery_successes = 0
        self._manager_probe_at = ""
        self._manager_modal_active = False
        self._control_loop_last_seen_at = ""
        self._control_loop_last_seen_monotonic = 0.0
        self._last_heartbeat_success_monotonic = 0.0
        self._last_state_refresh_at = time.monotonic()
        self.manager_visible = False
        self._config_mtime_ns = self._config_timestamp()
        self._last_config_warning_at = 0.0
        self._control_perf_log = state_path.parent / "logs" / "control_latency.jsonl"
        self._state_perf_cycle = 0
        self._heartbeat_cycle = 0
        self._last_ack_outbox_flush_monotonic = 0.0

    def _config_timestamp(self) -> int | None:
        if self.config_path is None:
            return None
        try:
            return self.config_path.stat().st_mtime_ns
        except OSError:
            return None

    def _reload_control_lock(self):
        if self.config_path is None:
            return
        modified_at = self._config_timestamp()
        if modified_at is None or modified_at == self._config_mtime_ns:
            return
        try:
            refreshed = BridgeConfig.load(self.config_path)
        except (OSError, json.JSONDecodeError) as exc:
            now = time.monotonic()
            if now - self._last_config_warning_at >= 10.0:
                logging.warning(
                    "설정 파일 저장 중인 상태를 감지해 기존 설정을 유지합니다: %s",
                    exc,
                )
                self._last_config_warning_at = now
            return
        self.config.armed = refreshed.armed
        self._config_mtime_ns = modified_at

    def _manager_visible(self) -> bool:
        if self.config.simulate:
            return True
        try:
            self.ui.diagnose()
            return True
        except Exception:
            return False

    def _refresh_state(
        self, perf_trace: ControlLatencyTrace | None = None
    ):
        total_started = time.perf_counter()
        update_started = time.perf_counter()
        self.state.update_remaining()
        if perf_trace is not None:
            perf_trace.mark(
                "STATE_DEADLINE_UPDATE",
                duration_ms=(time.perf_counter() - update_started) * 1000,
            )
        if self.config.simulate:
            self.manager_visible = True
            self._manager_modal_active = False
            if perf_trace is not None:
                perf_trace.mark(
                    "STATE_REFRESH_TOTAL",
                    duration_ms=(time.perf_counter() - total_started) * 1000,
                    details={"simulate": True},
                )
            return True

        try:
            observed_rooms = (
                self.ui.read_rooms()
                if perf_trace is None
                else self.ui.read_rooms(perf_trace)
            )
            self.manager_visible = True
        except Exception:
            self.manager_visible = False
            try:
                self._manager_modal_active = bool(self.ui.has_active_modal())
            except Exception:
                # A failed fresh read cannot prove the Manager is safe to
                # recover. Keep the recovery gate closed conservatively.
                self._manager_modal_active = True
            self._record_manager_probe_result(
                success=False,
                modal_active=self._manager_modal_active,
                count_for_recovery=False,
            )
            self.logs.apply(self.state.rooms)
            for room in self.state.rooms.values():
                if room.status != "running":
                    room.status = "offline"
            return False

        modal_probe_succeeded = False
        try:
            self._manager_modal_active = bool(self.ui.has_active_modal())
            modal_probe_succeeded = True
        except Exception:
            self._manager_modal_active = True

        for room_id, observed in observed_rooms.items():
            room = self.state.rooms[room_id]
            room.status = observed.status
            room.teamName = observed.teamName
            if observed.mapOptions:
                room.mapOptions = observed.mapOptions
            if observed.mapName:
                room.mapName = observed.mapName
            if observed.mapIndex:
                room.mapIndex = observed.mapIndex
            # 이 Qt 인원 콤보는 선택 후에도 현재값을 빈 문자열로 노출한다.
            # 원격 입력으로 확정한 마지막 인원값을 0으로 덮어쓰지 않는다.
            if observed.people:
                room.people = observed.people
            room.score = observed.score
            room.level = observed.level
            if observed.status != "running":
                room.remainingSeconds = 0
                room.deadline = ""
            else:
                # 관리자 프로그램 화면의 카운트다운이 실제 게임 기준값이다.
                # 원격 시작 때 만든 로컬 deadline은 UI를 잠시 읽지 못할 때만
                # 보조값으로 쓰고, 화면을 읽은 매 주기마다 실제 값으로 보정한다.
                room.remainingSeconds = observed.remainingSeconds
                if room.deadline:
                    room.deadline = (
                        datetime.now(timezone.utc)
                        + timedelta(seconds=observed.remainingSeconds)
                    ).isoformat()
        self._last_state_refresh_at = time.monotonic()
        self._record_manager_probe_result(
            success=modal_probe_succeeded and not self._manager_modal_active,
            modal_active=self._manager_modal_active,
            count_for_recovery=False,
            perf_trace=perf_trace,
        )
        if perf_trace is not None:
            perf_trace.mark(
                "STATE_REFRESH_TOTAL",
                duration_ms=(time.perf_counter() - total_started) * 1000,
                details={"simulate": False},
            )
        return True

    def _require_armed(self):
        if self.config.simulate:
            return
        if not self.config.armed:
            raise RuntimeError(
                "실제 제어가 잠겨 있습니다. bridge-config.json에서 armed를 true로 설정해 주세요."
            )

    def _execute(
        self,
        command: dict[str, Any],
        perf_trace: ControlLatencyTrace | None = None,
    ) -> RoomState | None:
        execute_started = time.perf_counter()
        parse_started = time.perf_counter()
        room_id = str(command.get("roomId", ""))
        action = str(command.get("action", ""))
        payload = command.get("payload", {})
        if not isinstance(payload, dict):
            payload = {}
        if perf_trace is not None:
            perf_trace.mark(
                "COMMAND_REQUEST_PARSE",
                duration_ms=(time.perf_counter() - parse_started) * 1000,
            )

        if action == "all_stop":
            self._require_armed()
            for target_id, room in self.state.rooms.items():
                if room.status != "running":
                    continue
                if self.config.simulate:
                    room.status = "waiting"
                    room.remainingSeconds = 0
                    room.deadline = ""
                else:
                    if perf_trace is None:
                        self.ui.stop(target_id)
                    else:
                        self.ui.stop(target_id, perf_trace)
                    time.sleep(0.2)
                    room.status = "waiting"
                    room.remainingSeconds = 0
                    room.deadline = ""
            save_started = time.perf_counter()
            self.state.save()
            if perf_trace is not None:
                perf_trace.mark(
                    "STATE_FILE_SAVE",
                    duration_ms=(time.perf_counter() - save_started) * 1000,
                )
                perf_trace.mark(
                    "COMMAND_EXECUTION_TOTAL",
                    duration_ms=(time.perf_counter() - execute_started) * 1000,
                )
            return None

        if room_id not in self.state.rooms:
            raise RuntimeError("지원하지 않는 게임존 명령입니다.")
        room = self.state.rooms[room_id]
        team_name = str(payload.get("teamName", "")).strip()[:10]
        map_index = max(0, min(50, int(payload.get("mapIndex", 0) or 0)))
        people = max(0, min(10, int(payload.get("people", 0) or 0)))
        skip_people = payload.get("skipPeople") is True
        duration = max(
            1, min(60, int(payload.get("durationMinutes", 16) or 16))
        )

        self._require_armed()
        if action in {"set_info", "start"}:
            # skipPeople means the Manager's fresh room value is authoritative.
            # ManagerUI reads it immediately before MQTT send; never substitute
            # the Bridge's cached snapshot for an "unchanged" request.
            manager_people = 0 if skip_people else people
            if perf_trace is not None:
                perf_trace.mark(
                    "SET_INFO_PAYLOAD_READY",
                    details={
                        "room": room_id,
                        "mapIndex": map_index,
                        "people": manager_people,
                        "skipPeople": skip_people,
                        "teamLength": len(team_name),
                    },
                )
            if not self.config.simulate:
                if perf_trace is None:
                    self.ui.set_room_info(
                        room_id,
                        team_name,
                        map_index,
                        manager_people,
                        skip_people,
                    )
                else:
                    self.ui.set_room_info(
                        room_id,
                        team_name,
                        map_index,
                        manager_people,
                        skip_people,
                        perf_trace,
                    )
            if perf_trace is not None:
                perf_trace.mark(
                    "SET_INFO_COMPLETED",
                    details={"room": room_id, "action": action},
                )
            room.teamName = team_name or room.teamName
            if map_index:
                room.mapIndex = map_index
                if 0 < map_index <= len(room.mapOptions):
                    room.mapName = room.mapOptions[map_index - 1]
            if not skip_people:
                room.people = people or room.people

        if action == "set_info":
            room.status = "waiting"
        elif action == "start":
            if not self.config.simulate:
                if perf_trace is None:
                    self.ui.start(room_id)
                else:
                    self.ui.start(room_id, perf_trace)
            room.status = "running"
            room.score = 0
            room.level = "gamestart"
            room.remainingSeconds = duration * 60
            room.deadline = (
                datetime.now(timezone.utc) + timedelta(minutes=duration)
            ).isoformat()
        elif action == "stop":
            if not self.config.simulate:
                if perf_trace is None:
                    self.ui.stop(room_id)
                else:
                    self.ui.stop(room_id, perf_trace)
            room.status = "waiting"
            room.remainingSeconds = 0
            room.deadline = ""
        else:
            raise RuntimeError("지원하지 않는 명령입니다.")

        save_started = time.perf_counter()
        self.state.save()
        if perf_trace is not None:
            perf_trace.mark(
                "STATE_FILE_SAVE",
                duration_ms=(time.perf_counter() - save_started) * 1000,
            )
            perf_trace.mark(
                "COMMAND_EXECUTION_TOTAL",
                duration_ms=(time.perf_counter() - execute_started) * 1000,
            )
        return room

    def _automatic_stops(self):
        # 남은시간은 운영 안내용으로만 사용한다. 시간이 0이 되어도 게임은
        # 계속 유지하며 웹의 정지/전체 정지 명령을 받았을 때만 종료한다.
        return

    @staticmethod
    def _control_now() -> str:
        return datetime.now().astimezone().isoformat(timespec="seconds")

    def _set_active_control(self, command_id: str = "", room_id: str = ""):
        with self._control_status_lock:
            self._active_control_command_id = command_id
            self._active_control_room_id = room_id if command_id else ""

    def _set_room_control_error(
        self,
        room_id: str,
        action: str,
        command_id: str,
        error_code: str,
        error: str,
        room_control_state: str,
        perf_trace: ControlLatencyTrace | None = None,
    ):
        now = self._control_now()
        with self._control_status_lock:
            self._room_control_errors[room_id] = {
                "roomId": room_id,
                "state": room_control_state,
                "action": action,
                "commandId": command_id,
                "errorCode": error_code,
                "errorMessage": str(error)[:300],
                "occurredAt": now,
                "lastSuccessAt": self._room_control_last_success_at.get(room_id, ""),
                "updatedAt": now,
            }
        if perf_trace is not None:
            perf_trace.mark(
                "ROOM_CONTROL_ERROR_SET",
                details={
                    "room": room_id,
                    "errorCode": error_code,
                    "roomControlState": room_control_state,
                },
            )

    def _clear_room_control_error(self, room_id: str):
        if not room_id:
            return
        now = self._control_now()
        with self._control_status_lock:
            self._room_control_errors.pop(room_id, None)
            self._room_control_last_success_at[room_id] = now

    def _mark_control_loop_seen(self):
        now = self._control_now()
        with self._control_status_lock:
            self._control_loop_last_seen_at = now
            self._control_loop_last_seen_monotonic = time.monotonic()

    def _record_manager_probe_result(
        self,
        *,
        success: bool,
        modal_active: bool,
        count_for_recovery: bool,
        perf_trace: ControlLatencyTrace | None = None,
    ) -> int:
        """Record only a fresh, successful Manager probe.

        A failed or ambiguous probe never refreshes ``managerProbeAt``. Healthy
        IDLE refreshes maintain the server's freshness TTL, while recovery
        probes advance hysteresis only when explicitly requested.
        """

        probe_at = self._control_now() if success else ""
        with self._control_status_lock:
            self._manager_modal_active = bool(modal_active)
            if success:
                self._manager_probe_at = probe_at
                if count_for_recovery or self._control_state == "IDLE":
                    self._control_recovery_successes = min(
                        CONTROL_RECOVERY_REQUIRED_PROBES,
                        self._control_recovery_successes + 1,
                    )
            else:
                self._control_recovery_successes = 0
            success_count = self._control_recovery_successes
        if success and perf_trace is not None:
            perf_trace.mark(
                "MANAGER_PROBE_OK", details={"successCount": success_count}
            )
        return success_count

    def _set_control_status(
        self,
        state: str,
        *,
        action: str = "",
        error: str = "",
        perf_trace: ControlLatencyTrace | None = None,
    ):
        now = self._control_now()
        with self._control_status_lock:
            previous = self._control_state
            self._control_state = state
            self._current_control_action = (
                action if state in {"BUSY", "ERROR", "DEGRADED"} else ""
            )
            if state == "BUSY":
                self._control_started_at = now
            else:
                self._control_started_at = ""
            if state == "IDLE":
                self._last_control_success_at = now
                self._last_control_error = ""
            elif state in {"ERROR", "DEGRADED"}:
                self._last_control_error = error[:300]
                self._control_recovery_successes = 0
            elif state == "BUSY":
                self._control_recovery_successes = 0
            command_id = self._active_control_command_id
        if previous != state:
            if perf_trace is not None:
                perf_trace.mark(
                    "GLOBAL_CONTROL_STATE_CHANGED",
                    details={"from": previous, "to": state},
                )
            logging.info(
                "[CONTROL RELIABILITY] stage=GLOBAL_CONTROL_STATE_CHANGED command_id=%s details=%s",
                command_id or "-",
                json.dumps(
                    {"from": previous, "to": state, "action": action},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            )

    def _control_status_snapshot(self) -> dict[str, Any]:
        now_monotonic = time.monotonic()
        with self._control_status_lock:
            room_errors = {
                room_id: dict(value)
                for room_id, value in self._room_control_errors.items()
            }
            active_command_id = self._active_control_command_id
            active_room_id = self._active_control_room_id
            room_success = dict(self._room_control_last_success_at)
            result = {
                "controlState": self._control_state,
                "currentControlAction": self._current_control_action,
                "controlStartedAt": self._control_started_at,
                "lastControlSuccessAt": self._last_control_success_at,
                "lastControlError": self._last_control_error,
                "activeControlCommandId": active_command_id,
                "managerProbeAt": self._manager_probe_at,
                "managerProbeSuccessCount": self._control_recovery_successes,
                "managerModalActive": self._manager_modal_active,
                "controlLoopLastSeen": self._control_loop_last_seen_at,
            }
        state_stale = now_monotonic - self._last_state_refresh_at > STATE_STALE_SECONDS
        manager_state = (
            "UNAVAILABLE"
            if not self.manager_visible
            else "STALE"
            if state_stale
            else "AVAILABLE"
        )
        room_states: list[dict[str, Any]] = []
        for room_id in self.state.rooms:
            if room_id in room_errors:
                room_states.append(room_errors[room_id])
                continue
            state = (
                "CONTROL_PENDING"
                if active_command_id and active_room_id == room_id
                else "STALE"
                if state_stale
                else "READY"
            )
            updated_at = room_success.get(room_id, "") or self._manager_probe_at
            room_states.append(
                {
                    "roomId": room_id,
                    "state": state,
                    "action": self._current_control_action if state == "CONTROL_PENDING" else "",
                    "commandId": active_command_id if state == "CONTROL_PENDING" else "",
                    "errorCode": "",
                    "errorMessage": "",
                    "occurredAt": "",
                    "lastSuccessAt": room_success.get(room_id, ""),
                    "updatedAt": updated_at,
                }
            )
        result.update(
            {
                "armed": self.config.armed,
                "simulate": self.config.simulate,
                "managerVisible": self.manager_visible,
                "managerState": manager_state,
                "stateStale": state_stale,
                "roomControlStates": room_states,
            }
        )
        return result

    def _consider_control_recovery(
        self, perf_trace: ControlLatencyTrace | None = None
    ) -> bool:
        """Recover only runtime readiness; never replay a failed command."""

        now = time.monotonic()
        with self._control_status_lock:
            current_state = self._control_state
            active_command_id = self._active_control_command_id
            control_loop_seen = self._control_loop_last_seen_monotonic
            claimed_command_ids = tuple(self._claimed_control_command_ids)
        if current_state not in {"DEGRADED", "ERROR"}:
            return False

        heartbeat_fresh = (
            self._last_heartbeat_success_monotonic > 0
            and now - self._last_heartbeat_success_monotonic
            <= max(2.0, self.config.heartbeat_seconds * 2.0)
        )
        control_loop_fresh = (
            control_loop_seen > 0
            and now - control_loop_seen
            <= max(2.0, self.config.control_poll_seconds * 5.0)
        )
        state_fresh = now - self._last_state_refresh_at <= STATE_STALE_SECONDS
        if (
            not heartbeat_fresh
            or not control_loop_fresh
            or not state_fresh
            or not self.manager_visible
            or active_command_id
            or claimed_command_ids
            or self.state.has_unresolved_commands()
        ):
            with self._control_status_lock:
                self._control_recovery_successes = 0
            return False

        if not self._manager_io_lock.acquire(blocking=False):
            with self._control_status_lock:
                self._control_recovery_successes = 0
            return False
        probe_ok = False
        modal_active = True
        try:
            with self._control_status_lock:
                if (
                    self._active_control_command_id
                    or self._claimed_control_command_ids
                ):
                    return False
            if self.state.has_unresolved_commands():
                return False
            if not self.config.simulate:
                if self.ui.info_api_enabled:
                    self.ui.info_api.probe()
                modal_active = bool(self.ui.has_active_modal())
            else:
                modal_active = bool(self._manager_modal_active)
            probe_ok = not modal_active
        except Exception as exc:
            logging.warning(
                "Manager recovery probe failed without command replay: %s",
                type(exc).__name__,
            )
        finally:
            self._manager_io_lock.release()

        probe_count = self._record_manager_probe_result(
            success=probe_ok,
            modal_active=modal_active,
            count_for_recovery=True,
            perf_trace=perf_trace,
        )
        if probe_ok:
            if perf_trace is not None:
                perf_trace.mark(
                    "CONTROL_RECOVERY_CANDIDATE",
                    details={"successCount": probe_count},
                )
            if probe_count >= CONTROL_RECOVERY_REQUIRED_PROBES:
                self._set_control_status("IDLE", perf_trace=perf_trace)
                if perf_trace is not None:
                    perf_trace.mark("CONTROL_RECOVERED")
                return True
        return False

    def _heartbeat_loop(self):
        delay = max(1.0, min(5.0, self.config.heartbeat_seconds))
        failures = 0
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                status = self._control_status_snapshot()
                self.heartbeat_remote.heartbeat(
                    self.config.agent_id,
                    self._bridge_instance_id,
                    status,
                )
                self._last_heartbeat_success_monotonic = time.monotonic()
                self._heartbeat_cycle += 1
                if status["controlState"] != "IDLE" or self._heartbeat_cycle % 5 == 1:
                    logging.info(
                        "[CONTROL RELIABILITY] stage=BRIDGE_HEARTBEAT_SENT command_id=- elapsed_ms=%.3f thread=%s process=%d details=%s",
                        (time.monotonic() - started) * 1000,
                        threading.current_thread().name,
                        os.getpid(),
                        json.dumps(
                            {
                                "controlState": status["controlState"],
                                "stateStale": status["stateStale"],
                            },
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ),
                    )
                if failures:
                    logging.info("Bridge heartbeat connection restored (%d retries)", failures)
                    failures = 0
                delay = max(1.0, min(5.0, self.config.heartbeat_seconds))
            except Exception as exc:
                failures += 1
                if failures == 1 or failures % 10 == 0:
                    logging.warning(
                        "Bridge heartbeat reconnecting (%d): %s",
                        failures,
                        type(exc).__name__,
                    )
                delay = min(5.0, max(delay * 1.5, 1.0))
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.2, delay - elapsed))

    def run_once(self):
        self._state_perf_cycle += 1
        state_trace = (
            ControlLatencyTrace(
                new_state_trace_id(),
                self._control_perf_log,
                kind="state_sync",
            )
            if not self.config.simulate and self._state_perf_cycle % 12 == 1
            else None
        )
        try:
            self._reload_control_lock()
            manager_lock_acquired = self._manager_io_lock.acquire(
                timeout=STATE_SYNC_LOCK_TIMEOUT_SECONDS
            )
            state_refreshed = False
            if manager_lock_acquired:
                try:
                    if state_trace is None:
                        state_refreshed = bool(self._refresh_state())
                    else:
                        state_refreshed = bool(self._refresh_state(state_trace))
                    if state_refreshed:
                        self._last_state_refresh_at = time.monotonic()
                finally:
                    self._manager_io_lock.release()
            elif state_trace is not None:
                state_trace.mark(
                    "STATE_REFRESH_SKIPPED_CONTROL_BUSY",
                    duration_ms=STATE_SYNC_LOCK_TIMEOUT_SECONDS * 1000,
                )
            if state_refreshed:
                self._consider_control_recovery(state_trace)
            self._automatic_stops()
            payment_status_started = time.perf_counter()
            payment_terminal = self.payment.refresh_status_if_due(time.monotonic())
            if state_trace is not None:
                state_trace.mark(
                    "PAYMENT_STATUS_REFRESH_IF_DUE",
                    duration_ms=(time.perf_counter() - payment_status_started) * 1000,
                )
            sync_started = time.perf_counter()
            commands = self.remote.sync(
                self.config.agent_id,
                self.state.rooms,
                armed=self.config.armed,
                simulate=self.config.simulate,
                manager_visible=self.manager_visible,
                payment_terminal=payment_terminal,
                perf_trace=state_trace,
            )
            if state_trace is not None:
                state_trace.mark(
                    "STATE_SYNC_HTTP_ROUND_TRIP",
                    duration_ms=(time.perf_counter() - sync_started) * 1000,
                    details={"commands": len(commands)},
                )
            self._process_commands(commands, self.remote)
            if state_trace is not None:
                state_trace.finish("completed")
        except Exception as exc:
            if state_trace is not None:
                state_trace.finish(
                    "failed", details={"errorType": type(exc).__name__}
                )
            raise

    def _ack_durable_command(
        self,
        remote: RemoteClient,
        command_id: str,
        status: str,
        result: str,
        room: RoomState | dict[str, Any] | None,
        *,
        perf_trace: ControlLatencyTrace | None = None,
        trace_id: str = "",
        latency_events: list[dict[str, Any]] | None = None,
        error_code: str = "",
        error_scope: str = "",
        room_control_state: str = "",
        pending_only: bool = False,
    ) -> bool:
        """Send an ACK without ever reclassifying an executed command."""

        with self._ack_delivery_lock:
            if pending_only and not self.state.is_ack_pending(command_id):
                return True
            try:
                remote.ack(
                    command_id,
                    status,
                    result,
                    room,
                    perf_trace=perf_trace,
                    trace_id=trace_id,
                    latency_events=latency_events,
                    error_code=error_code,
                    error_scope=error_scope,
                    room_control_state=room_control_state,
                )
            except RemoteResponseError as exc:
                if exc.status == 409 and "ACK_STATE_CONFLICT" in exc.detail.upper():
                    logging.error(
                        "명령 ACK 상태 충돌을 terminal reconciliation으로 격리: %s",
                        command_id,
                    )
                    try:
                        self.state.set_ack_pending(
                            command_id,
                            False,
                            resolution="ACK_STATE_CONFLICT",
                            error=str(exc),
                        )
                    except Exception:
                        logging.exception("ACK 충돌 조정 상태 저장 실패")
                    return True
                logging.warning(
                    "명령 결과 ACK 서버 거절; 실행 결과는 보존하고 재전송만 대기합니다: %s",
                    exc.status,
                )
                try:
                    self.state.set_ack_pending(
                        command_id,
                        True,
                        resolution="PENDING",
                        error=str(exc),
                    )
                except Exception:
                    logging.exception("ACK 대기 상태 저장 실패")
                return False
            except Exception as exc:
                logging.exception(
                    "명령 결과 ACK 전송 실패; 실행 결과는 보존하고 재전송만 대기합니다"
                )
                try:
                    self.state.set_ack_pending(
                        command_id,
                        True,
                        resolution="PENDING",
                        error=f"{type(exc).__name__}: {exc}",
                    )
                except Exception:
                    logging.exception("ACK 대기 상태 저장 실패")
                return False
            try:
                self.state.set_ack_pending(
                    command_id,
                    False,
                    resolution="ACKED",
                )
            except Exception:
                logging.exception("ACK 완료 상태 저장 실패")
            return True

    def _flush_ack_outbox(
        self,
        remote: RemoteClient,
        *,
        force: bool = False,
    ) -> int:
        """Retry only durable ACK delivery; never execute the command again."""

        now = time.monotonic()
        if (
            not force
            and now - self._last_ack_outbox_flush_monotonic
            < ACK_OUTBOX_FLUSH_SECONDS
        ):
            return 0
        self._last_ack_outbox_flush_monotonic = now
        resolved = 0
        for command_id, command in self.state.pending_ack_commands():
            ack_room = command.get("ackRoom")
            if not isinstance(ack_room, dict):
                ack_room = None
            if self._ack_durable_command(
                remote,
                command_id,
                str(command.get("status", "failed")),
                str(command.get("result", "")),
                ack_room,
                trace_id=str(command.get("traceId", "")),
                latency_events=command.get("latencyEvents", []),
                error_code=str(command.get("errorCode", "")),
                error_scope=str(command.get("errorScope", "")),
                room_control_state=str(command.get("roomControlState", "")),
                pending_only=True,
            ):
                resolved += 1
        return resolved

    def _process_commands(
        self,
        commands: list[dict[str, Any]],
        remote: RemoteClient,
    ):
        payment_actions = {
            "payment_status",
            "payment_pay",
            "payment_cancel",
        }
        claimed_control_ids = {
            str(command.get("id", ""))
            for command in commands
            if str(command.get("id", ""))
            and str(command.get("action", "")) not in payment_actions
        }
        if claimed_control_ids:
            with self._control_status_lock:
                self._claimed_control_command_ids.update(claimed_control_ids)
        try:
            self._process_claimed_commands(commands, remote, payment_actions)
        finally:
            if claimed_control_ids:
                with self._control_status_lock:
                    self._claimed_control_command_ids.difference_update(
                        claimed_control_ids
                    )

    def _process_claimed_commands(
        self,
        commands: list[dict[str, Any]],
        remote: RemoteClient,
        payment_actions: set[str],
    ):
        with self._control_status_lock:
            control_state_at_claim = self._control_state
            control_error_at_claim = self._last_control_error
        manager_batch_block: tuple[str, str] | None = (
            (
                "CONTROL_STATE_ERROR",
                control_error_at_claim or "Manager control is not ready.",
            )
            if control_state_at_claim == "ERROR"
            else None
        )
        for command in commands:
            command_started = time.perf_counter()
            command_id = str(command.get("id", ""))
            if not command_id:
                continue
            action = str(command.get("action", ""))
            room_id = str(command.get("roomId", ""))
            is_manager_control = action not in payment_actions
            local_control_trace_id = command_trace_id(command_id)
            control_trace = (
                None
                if action in {"payment_status", "payment_pay", "payment_cancel"}
                or not local_control_trace_id
                else ControlLatencyTrace(
                    local_control_trace_id,
                    self._control_perf_log,
                    kind="control_command",
                    action=action,
                    room_id=room_id,
                )
            )
            if control_trace is not None:
                control_trace.mark(
                    "BRIDGE_COMMAND_RECEIVED",
                    details={
                        "syncRoundTripMs": command.get("_bridgeSyncRttMs", 0),
                        "connectionReused": True,
                    },
                )
            if is_manager_control:
                ManagerUI._control_stage(
                    "CONTROL_COMMAND_RECEIVED",
                    command_id,
                    command_started,
                    control_trace,
                    action=action,
                    roomId=room_id,
                )
            previous = self.state.processed_commands.get(command_id)
            if previous is not None:
                if is_manager_control:
                    with self._control_status_lock:
                        self._claimed_control_command_ids.discard(command_id)
                status = previous["status"]
                result = previous["result"]
                if status == "executing":
                    status = "failed"
                    result = (
                        "이전 실행 중 연결이 끊겨 결과를 확정할 수 없습니다. "
                        "중복 실행을 막기 위해 다시 누르지 않았습니다."
                    )
                    self.state.mark_command(
                        command_id,
                        status,
                        result,
                        previous.get("roomId", ""),
                        ack_pending=True,
                    )
                    previous = self.state.processed_commands[command_id]
                stored_ack_room = previous.get("ackRoom")
                room: RoomState | dict[str, Any] | None = (
                    dict(stored_ack_room)
                    if isinstance(stored_ack_room, dict)
                    else self.state.rooms.get(previous.get("roomId", ""))
                )
                ack_sent = self._ack_durable_command(
                    remote,
                    command_id,
                    status,
                    result,
                    room,
                    perf_trace=control_trace,
                    trace_id=str(previous.get("traceId", "")),
                    latency_events=previous.get("latencyEvents", []),
                    error_code=str(previous.get("errorCode", "")),
                    error_scope=str(previous.get("errorScope", "")),
                    room_control_state=str(previous.get("roomControlState", "")),
                )
                if control_trace is not None:
                    control_trace.finish(
                        "duplicate-acknowledged" if ack_sent else "duplicate-ack-pending"
                    )
                logging.info("중복 명령을 재실행하지 않고 응답: %s", command_id)
                continue

            if is_manager_control and manager_batch_block is not None:
                blocked_by_code, blocked_by_message = manager_batch_block
                result = (
                    "공통 관리자 상태 오류가 발생해 같은 묶음의 후속 제어 명령을 "
                    "실행하지 않았습니다. 상태 복구 후 다시 실행해주세요."
                )
                self.state.mark_command(
                    command_id,
                    "failed",
                    result,
                    room_id,
                    error_code="CONTROL_BATCH_BLOCKED",
                    error_scope="global",
                    ack_pending=True,
                )
                ack_sent = self._ack_durable_command(
                    remote,
                    command_id,
                    "failed",
                    result,
                    None,
                    perf_trace=control_trace,
                    error_code="CONTROL_BATCH_BLOCKED",
                    error_scope="global",
                )
                with self._control_status_lock:
                    self._claimed_control_command_ids.discard(command_id)
                if control_trace is not None:
                    control_trace.finish(
                        "failed" if ack_sent else "failed-ack-pending",
                        details={
                            "errorType": "CONTROL_BATCH_BLOCKED",
                            "blockedBy": blocked_by_code,
                        },
                    )
                ManagerUI._control_stage(
                    "CONTROL_COMMAND_FINISHED",
                    command_id,
                    command_started,
                    None,
                    action=action,
                    status="failed",
                    errorType="CONTROL_BATCH_BLOCKED",
                    blockedBy=blocked_by_code,
                )
                logging.warning(
                    "후속 Manager 명령 실행 차단: command=%s blocker=%s detail=%s",
                    command_id,
                    blocked_by_code,
                    blocked_by_message[:120],
                )
                continue

            executing_save_started = time.perf_counter()
            self.state.mark_command(
                command_id,
                "executing",
                "매장 PC에서 실행 중",
                room_id,
            )
            if control_trace is not None:
                control_trace.mark(
                    "COMMAND_EXECUTING_STATE_SAVE",
                    duration_ms=(time.perf_counter() - executing_save_started) * 1000,
                )
            manager_action_executed = False
            try:
                trace_id = ""
                latency_events: list[dict[str, Any]] = []
                if action in {"payment_status", "payment_pay", "payment_cancel"}:
                    payload = command.get("payload", {})
                    if not isinstance(payload, dict):
                        payload = {}
                    else:
                        payload = dict(payload)
                    payload["_bridgeSyncRttMs"] = command.get("_bridgeSyncRttMs", 0)
                    payment_result = self.payment.execute(action, payload)
                    raw_events = payment_result.pop("_latency_events", [])
                    if isinstance(raw_events, list):
                        latency_events = [
                            event for event in raw_events if isinstance(event, dict)
                        ][:100]
                    trace_id = str(payment_result.get("trace_id", ""))
                    room = None
                    result = json.dumps(payment_result, ensure_ascii=False)
                else:
                    with self._control_status_lock:
                        state_before_busy = self._control_state
                        error_before_busy = self._last_control_error
                    self._set_active_control(command_id, room_id)
                    self._set_control_status(
                        "BUSY", action=action, perf_trace=control_trace
                    )
                    with self._manager_io_lock:
                        room = (
                            self._execute(command)
                            if control_trace is None
                            else self._execute(command, control_trace)
                        )
                    manager_action_executed = True
                    self._clear_room_control_error(room_id)
                    if state_before_busy in {"DEGRADED", "ERROR"}:
                        self._set_control_status(
                            "DEGRADED",
                            action=action,
                            error=error_before_busy,
                            perf_trace=control_trace,
                        )
                    else:
                        self._set_control_status("IDLE", perf_trace=control_trace)
                    result = "매장 PC 처리 완료"
                completed_save_started = time.perf_counter()
                self.state.mark_command(
                    command_id,
                    "completed",
                    result,
                    room.roomId if room is not None else room_id,
                    ack_pending=True,
                    ack_room=(room.public_dict() if isinstance(room, RoomState) else None),
                    trace_id=trace_id,
                    latency_events=latency_events,
                )
                if control_trace is not None:
                    control_trace.mark(
                        "COMMAND_COMPLETED_STATE_SAVE",
                        duration_ms=(time.perf_counter() - completed_save_started) * 1000,
                    )
                ack_sent = self._ack_durable_command(
                    remote,
                    command_id,
                    "completed",
                    result,
                    room,
                    perf_trace=control_trace,
                    trace_id=trace_id,
                    latency_events=latency_events,
                )
                if control_trace is not None:
                    control_trace.finish(
                        "completed" if ack_sent else "completed-ack-pending"
                    )
                if is_manager_control:
                    ManagerUI._control_stage(
                        "CONTROL_COMMAND_FINISHED",
                        command_id,
                        command_started,
                        None,
                        action=action,
                        status="completed",
                    )
                logging.info("명령 처리 완료: %s", command_id)
            except Exception as exc:
                logging.exception("명령 처리 실패: %s", command_id)
                result = str(exc)
                error_code = getattr(exc, "error_code", type(exc).__name__.upper())
                error_scope = getattr(exc, "scope", "global")
                room_control_state = getattr(
                    exc,
                    "room_control_state",
                    "CONTROL_FAILED",
                )
                if is_manager_control and not manager_action_executed:
                    if error_scope == "room":
                        self._set_room_control_error(
                            room_id,
                            action,
                            command_id,
                            error_code,
                            result,
                            room_control_state,
                            control_trace,
                        )
                        self._set_control_status(
                            "DEGRADED",
                            action=action,
                            error=result,
                            perf_trace=control_trace,
                        )
                    else:
                        manager_batch_block = (error_code, result)
                        self._set_control_status(
                            "ERROR",
                            action=action,
                            error=result,
                            perf_trace=control_trace,
                        )
                    if control_trace is not None and action in {"set_info", "start"}:
                        control_trace.mark(
                            "SET_INFO_FAILED",
                            details={
                                "room": room_id,
                                "errorCode": error_code,
                                "scope": error_scope,
                            },
                        )
                self.state.mark_command(
                    command_id,
                    "failed",
                    result,
                    room_id,
                    error_code=error_code,
                    error_scope=error_scope,
                    room_control_state=(
                        room_control_state if error_scope == "room" else ""
                    ),
                    ack_pending=True,
                )
                ack_sent = self._ack_durable_command(
                    remote,
                    command_id,
                    "failed",
                    result,
                    None,
                    perf_trace=control_trace,
                    error_code=error_code,
                    error_scope=error_scope,
                    room_control_state=(
                        room_control_state if error_scope == "room" else ""
                    ),
                )
                if control_trace is not None:
                    control_trace.finish(
                        "failed" if ack_sent else "failed-ack-pending",
                        details={"errorType": type(exc).__name__},
                    )
                if is_manager_control:
                    ManagerUI._control_stage(
                        "CONTROL_COMMAND_FINISHED",
                        command_id,
                        command_started,
                        None,
                        action=action,
                        status="failed",
                        errorType=type(exc).__name__,
                    )
            finally:
                if is_manager_control:
                    self._set_active_control()
                    with self._control_status_lock:
                        self._claimed_control_command_ids.discard(command_id)

    def _payment_loop(self):
        delay = max(0.1, min(1.0, self.config.payment_poll_seconds))
        failures = 0
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                commands = self.payment_remote.payment_commands(self.config.agent_id)
                self._process_commands(commands, self.payment_remote)
                if failures:
                    logging.info("Payment Fast Lane connection restored (%d retries)", failures)
                    failures = 0
                delay = max(0.1, min(1.0, self.config.payment_poll_seconds))
            except RemoteTransportError as exc:
                failures += 1
                if failures == 1 or failures % 10 == 0:
                    logging.warning("Payment Fast Lane reconnecting (%d): %s", failures, exc)
                delay = min(3.0, max(delay * 1.7, 0.5))
            except Exception:
                failures += 1
                logging.exception("Payment Fast Lane error")
                delay = min(3.0, max(delay * 1.7, 0.5))
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.1, delay - elapsed))

    def _control_loop(self):
        delay = max(0.1, min(1.0, self.config.control_poll_seconds))
        failures = 0
        while not self.stop_event.is_set():
            started = time.monotonic()
            self._mark_control_loop_seen()
            try:
                self._flush_ack_outbox(self.control_remote)
                commands = self.control_remote.control_commands(self.config.agent_id)
                self._process_commands(commands, self.control_remote)
                if failures:
                    logging.info("Control Fast Lane connection restored (%d retries)", failures)
                    failures = 0
                delay = max(0.1, min(1.0, self.config.control_poll_seconds))
            except RemoteTransportError as exc:
                failures += 1
                if failures == 1 or failures % 10 == 0:
                    logging.warning("Control Fast Lane reconnecting (%d): %s", failures, exc)
                delay = min(3.0, max(delay * 1.7, 0.5))
            except Exception:
                failures += 1
                logging.exception("Control Fast Lane error")
                delay = min(3.0, max(delay * 1.7, 0.5))
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.1, delay - elapsed))

    def _process_parking_commands(self, commands: list[dict[str, Any]]):
        for command in commands:
            command_id = str(command.get("id", ""))
            if not command_id:
                continue
            previous = self.state.processed_commands.get(command_id)
            if previous is not None:
                try:
                    if previous.get("status") == "completed":
                        result = json.loads(previous.get("result", "{}"))
                        command_status = "completed"
                    else:
                        result = {
                            "status": "NEEDS_REVIEW",
                            "matchCount": 0,
                            "results": [],
                            "errorCode": "BRIDGE_RESTARTED",
                            "errorMessage": "이전 처리 결과를 확인해야 하므로 자동 재등록하지 않았습니다.",
                            "dryRun": True,
                        }
                        command_status = "failed"
                    self.parking_remote.parking_ack(
                        self.config.agent_id,
                        command_id,
                        command_status,
                        result,
                    )
                except Exception:
                    logging.exception("중복 주차등록 명령 응답 실패: %s", command_id)
                continue

            payload = command.get("payload", {})
            if not isinstance(payload, dict):
                payload = {}
            self.state.mark_command(command_id, "executing", "주차등록 처리 중", "PARKING")
            try:
                result = self.parking.register(
                    payload,
                    policy_check=lambda: self.parking_remote.parking_policy(
                        self.config.agent_id
                    ),
                )
                serialized = json.dumps(result, ensure_ascii=False)
                self.state.mark_command(
                    command_id,
                    "completed",
                    serialized,
                    "PARKING",
                )
                self.parking_remote.parking_ack(
                    self.config.agent_id,
                    command_id,
                    "completed",
                    result,
                )
                logging.info(
                    "주차등록 명령 처리 완료: %s (%s)",
                    command_id,
                    result.get("status", ""),
                )
            except Exception as exc:
                logging.exception("주차등록 명령 처리 실패: %s", command_id)
                result = {
                    "status": "FAILED",
                    "matchCount": 0,
                    "results": [],
                    "errorCode": type(exc).__name__,
                    "errorMessage": "주차등록 처리 중 오류가 발생했습니다.",
                    "dryRun": True,
                }
                self.state.mark_command(
                    command_id,
                    "failed",
                    json.dumps(result, ensure_ascii=False),
                    "PARKING",
                )
                try:
                    self.parking_remote.parking_ack(
                        self.config.agent_id,
                        command_id,
                        "failed",
                        result,
                    )
                except Exception:
                    logging.exception("주차등록 실패 응답 전송 실패")

    def _parking_loop(self):
        delay = max(0.5, min(5.0, self.config.parking_poll_seconds))
        failures = 0
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                commands = self.parking_remote.parking_commands(self.config.agent_id)
                self._process_parking_commands(commands)
                if failures:
                    logging.info("Parking Lane connection restored (%d retries)", failures)
                    failures = 0
                delay = max(0.5, min(5.0, self.config.parking_poll_seconds))
            except RemoteTransportError as exc:
                failures += 1
                if failures == 1 or failures % 10 == 0:
                    logging.warning("Parking Lane reconnecting (%d): %s", failures, exc)
                delay = min(8.0, max(delay * 1.7, 1.0))
            except Exception:
                failures += 1
                logging.exception("Parking Lane error")
                delay = min(8.0, max(delay * 1.7, 1.0))
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.2, delay - elapsed))

    def _local_payment_sync_loop(self):
        if self.local_payment_runtime is None:
            return
        while not self.stop_event.is_set():
            self.local_payment_runtime.wait_for_sync(0.5)
            if self.stop_event.is_set():
                break
            try:
                self.local_payment_runtime.sync_due()
            except Exception:
                logging.exception("Local Direct cloud outbox sync error")

    def run(self):
        logging.info(
            "점핑배틀 원격 제어 모듈 %s 시작 (armed=%s, simulate=%s)",
            VERSION,
            self.config.armed,
            self.config.simulate,
        )
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            name="bridge-heartbeat",
            daemon=True,
        )
        self._heartbeat_thread.start()
        logging.info(
            "Bridge heartbeat started (interval=%.2fs)",
            self.config.heartbeat_seconds,
        )
        self._payment_thread = threading.Thread(
            target=self._payment_loop,
            name="payment-fast-lane",
            daemon=True,
        )
        self._payment_thread.start()
        logging.info("Payment Fast Lane started (poll=%.2fs)", self.config.payment_poll_seconds)
        self._control_thread = threading.Thread(
            target=self._control_loop,
            name="control-fast-lane",
            daemon=True,
        )
        self._control_thread.start()
        logging.info("Control Fast Lane started (poll=%.2fs)", self.config.control_poll_seconds)
        self._parking_thread = threading.Thread(
            target=self._parking_loop,
            name="parking-lane",
            daemon=True,
        )
        self._parking_thread.start()
        logging.info("Parking Lane started (poll=%.2fs)", self.config.parking_poll_seconds)
        if self.local_payment_server is not None and self.local_payment_runtime is not None:
            self.local_payment_server.start()
            self._local_payment_sync_thread = threading.Thread(
                target=self._local_payment_sync_loop,
                name="local-payment-cloud-sync",
                daemon=True,
            )
            self._local_payment_sync_thread.start()
            logging.info(
                "Local Direct Payment V2 started on http://%s:%d",
                self.config.local_payment_host,
                self.config.local_payment_port,
            )
        delay = self.config.poll_seconds
        network_failures = 0
        last_network_warning_at = 0.0
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                self.run_once()
                if network_failures:
                    logging.info(
                        "원격 서버 연결 복구(%d회 재시도 후)",
                        network_failures,
                    )
                    network_failures = 0
                delay = self.config.poll_seconds
            except RemoteTransportError as exc:
                network_failures += 1
                now = time.monotonic()
                if network_failures == 1 or now - last_network_warning_at >= 60:
                    logging.warning(
                        "원격 서버 응답 지연, 자동 재연결 중(%d회): %s",
                        network_failures,
                        exc,
                    )
                    last_network_warning_at = now
                delay = min(8.0, max(delay * 1.7, 1.0))
            except Exception:
                logging.exception("동기화 오류")
                # 일시적인 서버/인터넷 오류 뒤에도 명령 수신이 오래 멈추지
                # 않도록 1초부터 재시도하고 최대 대기는 8초로 제한한다.
                delay = min(8.0, max(delay * 1.7, 1.0))
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.2, delay - elapsed))

    def close(self):
        self.stop_event.set()
        if self.local_payment_server is not None:
            self.local_payment_server.close()
        if self._payment_thread is not None and self._payment_thread.is_alive():
            self._payment_thread.join(timeout=3.0)
        if self._heartbeat_thread is not None and self._heartbeat_thread.is_alive():
            self._heartbeat_thread.join(timeout=3.0)
        if self._control_thread is not None and self._control_thread.is_alive():
            self._control_thread.join(timeout=3.0)
        if self._parking_thread is not None and self._parking_thread.is_alive():
            self._parking_thread.join(timeout=3.0)
        if self._local_payment_sync_thread is not None and self._local_payment_sync_thread.is_alive():
            self._local_payment_sync_thread.join(timeout=3.0)
        self.remote.close()
        self.heartbeat_remote.close()
        self.payment_remote.close()
        self.control_remote.close()
        self.parking_remote.close()
        self.local_payment_remote.close()
        self.payment.close()
        self.parking.close()


def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def runtime_dir() -> Path:
    """Store mutable runtime data outside synced folders such as OneDrive."""
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        base = Path(local_app_data)
    else:
        base = Path(os.environ.get("TEMP", str(app_dir())))
    path = base / "JumpingBattleRemoteBridge"
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_default_config(path: Path):
    config = BridgeConfig(
        agent_id=f"store-{uuid.uuid4().hex[:8]}",
    )
    path.write_text(
        json.dumps(asdict(config), ensure_ascii=False, indent=2), encoding="utf-8"
    )


def set_config_armed(path: Path, enabled: bool) -> dict[str, Any]:
    config = BridgeConfig.load(path)
    diagnosis: dict[str, Any] = {"safe": True, "simulate": True}
    if enabled and not config.simulate:
        diagnosis = manager_ui_from_config(config).diagnose()

    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise RuntimeError("설정 파일 형식이 올바르지 않습니다.")
    data["armed"] = enabled
    temp = path.with_suffix(".tmp")
    temp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temp.replace(path)
    return {"armed": enabled, "safe": bool(diagnosis.get("safe"))}


def acquire_single_instance(agent_id: str):
    if os.name != "nt":
        return None
    import ctypes

    safe_agent_id = re.sub(r"[^A-Za-z0-9_.-]", "_", agent_id)[:80]
    mutex_name = f"Local\\JumpingBattleRemoteBridge_{safe_agent_id}"
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, mutex_name)
    if not handle:
        raise RuntimeError("중복 실행 방지 잠금을 만들지 못했습니다.")
    if ctypes.windll.kernel32.GetLastError() == 183:
        ctypes.windll.kernel32.CloseHandle(handle)
        raise RuntimeError("보조 프로그램이 이미 실행 중입니다.")
    return handle


def release_single_instance(handle):
    if handle and os.name == "nt":
        import ctypes

        ctypes.windll.kernel32.CloseHandle(handle)


def parse_args():
    parser = argparse.ArgumentParser(description="점핑배틀 원격 제어 보조 프로그램")
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    parser.add_argument(
        "--config",
        type=Path,
        default=app_dir() / "bridge-config.json",
        help="설정 파일 경로",
    )
    parser.add_argument("--once", action="store_true", help="한 번만 동기화")
    parser.add_argument("--diagnose", action="store_true", help="관리자 창만 점검")
    parser.add_argument(
        "--payment-status",
        action="store_true",
        help="실제 거래 없이 KPN MPOS 단말 상태만 확인",
    )
    parser.add_argument(
        "--create-config", action="store_true", help="기본 설정 파일 생성"
    )
    parser.add_argument(
        "--set-armed",
        choices=("true", "false"),
        help="안전 확인 후 실제 원격 제어 잠금을 켜거나 끔",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    base = app_dir()
    runtime = runtime_dir()
    log_path = runtime / "jumping-bridge.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler(log_path, encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )

    if args.create_config:
        if args.config.exists():
            raise SystemExit(f"설정 파일이 이미 있습니다: {args.config}")
        write_default_config(args.config)
        print(f"설정 파일 생성 완료: {args.config}")
        return

    if not args.config.exists():
        write_default_config(args.config)
        raise SystemExit(
            f"설정 파일을 만들었습니다. 서버 주소와 토큰을 확인한 뒤 다시 실행하세요: {args.config}"
        )

    config = BridgeConfig.load(args.config)
    if args.payment_status:
        service = (
            PaymentService.from_bridge_config(
                config,
                application_dir=base,
                runtime_dir=runtime,
                auto_status=False,
            )
            if config.mpos_enabled
            else DisabledPaymentService()
        )
        try:
            if isinstance(service, PaymentService):
                result = service.execute("payment_status", {"traceId": new_trace_id()})
                result.pop("_latency_events", None)
            else:
                result = service.terminal_snapshot()
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if not result.get("success"):
                raise SystemExit(2)
        finally:
            service.close()
        return
    if args.set_armed is not None:
        try:
            result = set_config_armed(args.config, args.set_armed == "true")
            print(json.dumps(result, ensure_ascii=False, indent=2))
        except Exception as exc:
            print(
                json.dumps(
                    {"armed": False, "safe": False, "error": str(exc)},
                    ensure_ascii=False,
                    indent=2,
                )
            )
            raise SystemExit(2) from None
        return

    if args.diagnose:
        try:
            result = (
                {"simulate": True, "safe": True}
                if config.simulate
                else manager_ui_from_config(config).diagnose()
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
        except Exception as exc:
            print(
                json.dumps(
                    {"safe": False, "error": str(exc)},
                    ensure_ascii=False,
                    indent=2,
                )
            )
            raise SystemExit(2) from None
        return

    bridge = Bridge(config, runtime / "bridge-state.json", args.config)
    instance_handle = None
    try:
        if args.once:
            bridge.run_once()
        else:
            instance_handle = acquire_single_instance(config.agent_id)
            bridge.run()
    except KeyboardInterrupt:
        logging.info("사용자 요청으로 종료합니다.")
    except RuntimeError as exc:
        logging.error(str(exc))
        raise SystemExit(2) from None
    finally:
        bridge.close()
        release_single_instance(instance_handle)


if __name__ == "__main__":
    main()
