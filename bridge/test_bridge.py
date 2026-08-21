from __future__ import annotations

import json
import re
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from jumping_bridge import (
    Bridge,
    BridgeConfig,
    InfoApiUnsupported,
    LocalMqttPublisher,
    ManagerLogReader,
    ManagerInfoApi,
    RoomControlError,
    RoomStateReadError,
    ManagerStateUnavailableError,
    ManagerUI,
    PANEL_AUTO_ID,
    RemoteClient,
    RemoteResponseError,
    RemoteTransportError,
    SetInfoVerificationError,
    RoomState,
    StateStore,
    VERSION,
    set_config_armed,
)


class FakeHttpResponse:
    def __init__(self, payload, status=200, will_close=False):
        self.payload = payload
        self.status = status
        self.will_close = will_close

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class FakeHttpConnection:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.closed = 0

    def request(self, method, path, body=None, headers=None):
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response

    def close(self):
        self.closed += 1


class FakeRemote:
    def __init__(self, command):
        self.command = command
        self.acks = []
        self.ack_metadata = []

    def sync(self, _agent_id, _rooms, **_runtime):
        return [self.command]

    def ack(self, command_id, status, result, room=None, **metadata):
        self.acks.append((command_id, status, result, room))
        self.ack_metadata.append(metadata)

    def close(self):
        return None


class FakePaymentService:
    def __init__(self):
        self.execute_calls = 0
        self.closed = False
        self.status = {
            "kind": "terminal_status",
            "success": True,
            "error_code": "NONE",
            "checked_at": "2026-08-10T00:00:00+00:00",
        }

    def refresh_status_if_due(self, _now):
        return dict(self.status)

    def execute(self, action, payload):
        self.execute_calls += 1
        return {
            "kind": "payment",
            "success": True,
            "transaction_uuid": payload["transactionUuid"],
            "transaction_type": "PAY",
            "status": "APPROVED",
            "amount": payload["amount"],
            "response_code": "0000",
            "response_message": "정상처리",
            "auth_no": "A12345",
            "auth_date": "20260810120000",
            "issuer_name": "테스트카드",
            "acquirer_name": "테스트매입",
            "masked_card_no": "1234********5678",
            "raw_return_code": 0,
            "error_code": "NONE",
            "elapsed_ms": 25,
            "mpos_transaction_id": 1,
        }

    def close(self):
        self.closed = True


class BridgeTests(unittest.TestCase):
    def test_payment_command_is_serialized_to_safe_ack_and_never_replayed(self):
        with tempfile.TemporaryDirectory() as folder:
            payment = FakePaymentService()
            command = {
                "id": "payment-command-1",
                "roomId": "PAYMENT",
                "action": "payment_pay",
                "payload": {
                    "reservationId": "reservation-1",
                    "transactionUuid": "reservation-1-PAY-1",
                    "amount": 1000,
                },
            }
            bridge = Bridge(
                BridgeConfig(simulate=True),
                Path(folder) / "state.json",
                payment_service=payment,
            )
            remote = FakeRemote(command)
            bridge.remote = remote

            bridge.run_once()
            bridge.run_once()

            self.assertEqual(payment.execute_calls, 1)
            self.assertEqual(len(remote.acks), 2)
            first_payload = json.loads(remote.acks[0][2])
            second_payload = json.loads(remote.acks[1][2])
            self.assertEqual(first_payload["status"], "APPROVED")
            self.assertEqual(second_payload, first_payload)
            self.assertNotIn("track", remote.acks[0][2].lower())
            bridge.close()
            self.assertTrue(payment.closed)

    def test_remote_client_reuses_one_https_connection(self):
        client = RemoteClient(
            BridgeConfig(server_url="https://example.test", agent_token="token")
        )
        connection = FakeHttpConnection(
            [FakeHttpResponse({"commands": []}), FakeHttpResponse({"ok": True})]
        )
        created = []

        def new_connection():
            created.append(connection)
            return connection

        client._new_connection = new_connection

        self.assertEqual(client.post("/api/agent/sync", {})["commands"], [])
        self.assertTrue(client.post("/api/agent/ack", {})["ok"])
        self.assertEqual(len(created), 1)
        self.assertEqual(len(connection.requests), 2)
        self.assertEqual(connection.closed, 0)

    def test_payment_fast_lane_uses_its_dedicated_endpoint(self):
        client = RemoteClient(
            BridgeConfig(server_url="https://example.test", agent_token="token")
        )
        connection = FakeHttpConnection([FakeHttpResponse({"commands": []})])
        client._new_connection = lambda: connection

        self.assertEqual(client.payment_commands("store-agent"), [])
        method, path, body, _headers = connection.requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/api/agent/payment-commands")
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(payload["agentId"], "store-agent")
        self.assertEqual(payload["version"], VERSION)

    def test_control_fast_lane_uses_its_dedicated_endpoint(self):
        client = RemoteClient(
            BridgeConfig(server_url="https://example.test", agent_token="token")
        )
        connection = FakeHttpConnection([FakeHttpResponse({"commands": []})])
        client._new_connection = lambda: connection

        self.assertEqual(client.control_commands("store-agent"), [])
        method, path, body, _headers = connection.requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/api/agent/control-commands")
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(payload["agentId"], "store-agent")
        self.assertEqual(payload["version"], VERSION)

    def test_heartbeat_uses_independent_endpoint_and_runtime_state(self):
        client = RemoteClient(
            BridgeConfig(server_url="https://example.test", agent_token="token")
        )
        connection = FakeHttpConnection([FakeHttpResponse({"ok": True})])
        client._new_connection = lambda: connection

        client.heartbeat(
            "store-agent",
            "instance-1",
            {
                "controlState": "BUSY",
                "currentControlAction": "stop",
                "stateStale": True,
            },
        )

        method, path, body, _headers = connection.requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/api/agent/heartbeat")
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(payload["bridgeInstanceId"], "instance-1")
        self.assertEqual(payload["controlState"], "BUSY")
        self.assertEqual(payload["currentControlAction"], "stop")

    def test_remote_ack_serializes_room_control_state(self):
        client = RemoteClient(
            BridgeConfig(server_url="https://example.test", agent_token="token")
        )
        connection = FakeHttpConnection([FakeHttpResponse({"ok": True})])
        client._new_connection = lambda: connection

        client.ack(
            "command-1",
            "failed",
            "verify failed",
            error_code="MAP_VERIFY_FAILED",
            error_scope="room",
            room_control_state="SET_INFO_FAILED",
        )

        _method, path, body, _headers = connection.requests[0]
        self.assertEqual(path, "/api/agent/ack")
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(payload["errorCode"], "MAP_VERIFY_FAILED")
        self.assertEqual(payload["errorScope"], "room")
        self.assertEqual(payload["roomControlState"], "SET_INFO_FAILED")

    def test_payment_latency_events_travel_outside_result_json(self):
        with tempfile.TemporaryDirectory() as folder:
            payment = FakePaymentService()
            payment.execute = lambda _action, _payload: {
                "kind": "payment",
                "status": "APPROVED",
                "trace_id": "PAY-20260811-201500-AB12CD",
                "_latency_events": [{
                    "trace_id": "PAY-20260811-201500-AB12CD",
                    "component": "bridge",
                    "stage": "BRIDGE_RESPONSE_START",
                    "iso_timestamp": "2026-08-11T20:15:01.000+09:00",
                    "elapsed_ms": 10,
                    "duration_ms": None,
                    "details": {},
                }],
            }
            command = {
                "id": "payment-trace-command",
                "roomId": "PAYMENT",
                "action": "payment_pay",
                "payload": {
                    "reservationId": "reservation-1",
                    "transactionUuid": "reservation-1-PAY-1",
                    "amount": 1000,
                    "traceId": "PAY-20260811-201500-AB12CD",
                },
            }
            bridge = Bridge(
                BridgeConfig(simulate=True),
                Path(folder) / "state.json",
                payment_service=payment,
            )
            remote = FakeRemote(command)
            bridge.remote = remote
            bridge.run_once()
            result = json.loads(remote.acks[0][2])
            self.assertNotIn("_latency_events", result)
            self.assertNotIn("latency_events", result)
            self.assertEqual(
                remote.ack_metadata[0]["trace_id"],
                "PAY-20260811-201500-AB12CD",
            )
            self.assertEqual(
                remote.ack_metadata[0]["latency_events"][0]["stage"],
                "BRIDGE_RESPONSE_START",
            )
            bridge.close()

    def test_remote_client_reconnects_once_after_read_timeout(self):
        client = RemoteClient(
            BridgeConfig(server_url="https://example.test", agent_token="token")
        )
        first = FakeHttpConnection([TimeoutError("read timed out")])
        second = FakeHttpConnection([FakeHttpResponse({"commands": []})])
        connections = [first, second]
        client._new_connection = lambda: connections.pop(0)

        self.assertEqual(client.post("/api/agent/sync", {})["commands"], [])
        self.assertEqual(first.closed, 1)
        self.assertEqual(len(second.requests), 1)

    def test_remote_client_reports_compact_error_after_retries(self):
        client = RemoteClient(
            BridgeConfig(server_url="https://example.test", agent_token="token")
        )
        connections = [
            FakeHttpConnection([TimeoutError("read timed out")]),
            FakeHttpConnection([TimeoutError("read timed out")]),
        ]
        client._new_connection = lambda: connections.pop(0)

        with self.assertRaisesRegex(RemoteTransportError, "2회 재시도"):
            client.post("/api/agent/sync", {})

    def test_remote_client_retries_temporary_server_error(self):
        client = RemoteClient(
            BridgeConfig(server_url="https://example.test", agent_token="token")
        )
        first = FakeHttpConnection(
            [FakeHttpResponse({"error": "temporary"}, status=503)]
        )
        second = FakeHttpConnection([FakeHttpResponse({"commands": []})])
        connections = [first, second]
        client._new_connection = lambda: connections.pop(0)

        self.assertEqual(client.post("/api/agent/sync", {})["commands"], [])
        self.assertEqual(first.closed, 1)

    def test_manager_info_api_publishes_known_map_serial(self):
        class FakePublisher:
            def __init__(self):
                self.calls = []

            def publish_json(self, topic, payload):
                self.calls.append((topic, payload))

        publisher = FakePublisher()
        api = ManagerInfoApi(publisher)

        serial = api.send("2", "대형-여름맵", "테스트팀", 3)

        self.assertEqual(serial, 250)
        self.assertEqual(publisher.calls[0][0], "JP/app")
        self.assertEqual(
            publisher.calls[0][1],
            {
                "cmd": "infook",
                "id": 2,
                "map_serial": 250,
                "teamname": "테스트팀",
                "num_people": 3,
            },
        )

    def test_manager_info_api_rejects_unknown_map_without_publish(self):
        class FakePublisher:
            def publish_json(self, _topic, _payload):
                raise AssertionError("unsupported input must not be published")

        with self.assertRaises(InfoApiUnsupported):
            ManagerInfoApi(FakePublisher()).send("0", "중형-신규맵", "테스트", 2)

    def test_mqtt_packet_uses_v311_connect_and_utf8_publish(self):
        publisher = LocalMqttPublisher(username="user", password="pass")
        connect_packet = publisher._connect_packet("bridge-test")
        publish_packet = publisher._publish_packet(
            "JP/app", '{"teamname":"한글"}'.encode("utf-8")
        )

        self.assertEqual(connect_packet[0], 0x10)
        self.assertIn(b"\x00\x04MQTT\x04\xc2", connect_packet)
        self.assertEqual(publish_packet[0], 0x30)
        self.assertIn(b"\x00\x06JP/app", publish_packet)
        self.assertIn("한글".encode("utf-8"), publish_packet)

    def test_set_room_info_does_not_hide_api_failure_with_uia_fallback(self):
        ui = ManagerUI("manager")
        window = object()
        ui._window = lambda: window
        ui.room_status = lambda _room_id, _window: "waiting"
        calls = []

        def fail_api(*_args):
            calls.append("api")
            raise RuntimeError("temporary API failure")

        ui._set_room_info_api = fail_api
        ui._set_room_info_uia = lambda *_args: calls.append("uia")

        with self.assertRaisesRegex(RuntimeError, "화면 입력으로 자동 전환하지 않았습니다"):
            ui.set_room_info("0", "팀", 1, 2)

        self.assertEqual(calls, ["api"])

    def test_set_room_info_uses_uia_only_for_explicitly_unsupported_api_input(self):
        class FakeControl:
            def __init__(self, value):
                self.value = value

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

        ui = ManagerUI("manager")
        window = object()
        ui._window = lambda: window
        controls = {
            "status": FakeControl("대기"),
            "team": FakeControl("팀"),
            "map": FakeControl("중형-Basic"),
            "people": FakeControl("2명"),
        }
        ui._room_controls = lambda _window, _room_id, names: {
            name: controls[name] for name in names
        }
        calls = []

        def unsupported_api(*_args):
            calls.append("api")
            raise InfoApiUnsupported("B1 중형 모드")

        ui._set_room_info_api = unsupported_api
        ui._set_room_info_uia = lambda *_args: calls.append("uia")

        ui.set_room_info("2", "팀", 11, 2)

        self.assertEqual(calls, ["api", "uia"])

    def test_manager_window_is_reused_after_first_safe_discovery(self):
        class CachedWindow:
            calls = 0

            def window_text(self):
                self.calls += 1
                return "점핑배틀 관리자 프로그램 [ver.v2.0.3]"

        ui = ManagerUI("점핑배틀 관리자 프로그램")
        cached = CachedWindow()
        ui._cached_window = cached

        self.assertIs(ui._window(), cached)
        self.assertIs(ui._window(), cached)
        self.assertEqual(cached.calls, 2)

    def test_uia_fallback_skips_map_when_api_already_applied_it(self):
        class FakeControl:
            def __init__(self, value):
                self.value = value

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

        ui = ManagerUI("manager")
        ui._map_options["0"] = ui._fallback_map_options("0")
        ui._room_controls = lambda *_args: {
            "status": FakeControl("대기"),
            "team": FakeControl("테스트"),
            "map": FakeControl("중형-Normal"),
        }
        ui._select_combo_text = lambda *_args, **_kwargs: self.fail(
            "already applied map must not be selected again"
        )

        ui._set_room_info_uia("0", "테스트", 3, 0, True, object())

    def test_b1_medium_mode_skips_unsupported_manager_api_immediately(self):
        class FakeControl:
            def __init__(self, value=""):
                self.value = value

            def get_value(self):
                return self.value

        class RejectPublisher:
            def publish_json(self, _topic, _payload):
                raise AssertionError("B1 medium mode must not be published to MQTT")

        ui = ManagerUI("manager", info_api=ManagerInfoApi(RejectPublisher()))
        ui._combo_options = lambda _combo: self.fail(
            "B1 write path must not open the map dropdown to discover options"
        )
        controls = {
            "status": FakeControl("대기"),
            "team": FakeControl("테스트"),
            "map": FakeControl("대형-Basic"),
            "people": FakeControl("2명"),
            "info": FakeControl(),
        }
        ui._room_controls = lambda _window, _room_id, names: {
            name: controls[name] for name in names
        }

        with self.assertRaisesRegex(InfoApiUnsupported, "B1 중형 모드"):
            ui._set_room_info_api(object(), "2", "테스트", 11, 2)

    def test_b1_uia_fallback_uses_stable_map_order_without_discovery_popup(self):
        class FakeControl:
            def __init__(self, value=""):
                self.value = value

            def get_value(self):
                return self.value

        ui = ManagerUI("manager")
        ui._combo_options = lambda _combo: self.fail(
            "B1 fallback must open the combo only for the final selection"
        )
        controls = {
            "status": FakeControl("대기"),
            "team": FakeControl("테스트"),
            "map": FakeControl("대형-Basic"),
        }
        ui._room_controls = lambda *_args, **_kwargs: controls
        selected = []
        ui._select_combo_text = (
            lambda _combo, expected, _error, **kwargs: selected.append(
                (expected, kwargs.get("fallback_index"))
            )
        )

        ui._set_room_info_uia("2", "테스트", 11, 0, True, object())

        self.assertEqual(selected, [("중형-Basic", 10)])

    def test_skip_people_keeps_current_value_and_finishes_on_team_map_update(self):
        class FakeControl:
            def __init__(self, value=""):
                self.value = value
                self.invoked = 0

            def get_value(self):
                return self.value

            def invoke(self):
                self.invoked += 1

        controls = {
            "status": FakeControl("대기"),
            "team": FakeControl("기존팀"),
            "map": FakeControl("중형-Basic"),
            "people": FakeControl("3명"),
            "info": FakeControl(),
        }

        class FakeInfoApi:
            def __init__(self):
                self.calls = []

            def send(self, room_id, map_name, team_name, people):
                self.calls.append((room_id, map_name, team_name, people))
                controls["team"].value = team_name
                controls["map"].value = map_name

        info_api = FakeInfoApi()
        ui = ManagerUI("manager", info_api=info_api)
        ui._window = lambda: object()
        ui._map_options["0"] = ui._fallback_map_options("0")
        ui._room_controls = lambda _window, _room_id, names: {
            name: controls[name] for name in names
        }

        ui._set_room_info_api(object(), "0", "새팀", 2, 9, True)

        self.assertEqual(info_api.calls, [("0", "중형-Easy", "새팀", 3)])
        self.assertEqual(controls["people"].value, "3명")
        self.assertEqual(controls["info"].invoked, 1)

    def test_skip_people_unreadable_fails_before_mqtt_send(self):
        class FakeControl:
            def __init__(self, value=""):
                self.value = value
                self.invoked = 0

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

            def invoke(self):
                self.invoked += 1

        class UnreadableControl:
            pass

        controls = {
            "status": FakeControl("대기"),
            "team": FakeControl("기존팀"),
            "map": FakeControl("중형-Basic"),
            "people": UnreadableControl(),
            "info": FakeControl(),
        }

        class FakeInfoApi:
            def __init__(self):
                self.calls = []

            def send(self, *args):
                self.calls.append(args)

        info_api = FakeInfoApi()
        ui = ManagerUI("manager", info_api=info_api)
        ui._window = lambda: object()
        ui._map_options["0"] = ui._fallback_map_options("0")
        ui._room_controls = lambda _window, _room_id, names: {
            name: controls[name] for name in names
        }

        with self.assertRaises(RoomStateReadError) as caught:
            ui._set_room_info_api(object(), "0", "새팀", 2, 9, True)

        self.assertEqual(caught.exception.error_code, "STATE_READ_FAILED")
        self.assertEqual(info_api.calls, [])
        self.assertEqual(controls["info"].invoked, 0)

    def test_set_info_fresh_verification_accepts_bounded_delayed_apply(self):
        class FakeControl:
            def __init__(self, value=""):
                self.value = value

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

            def invoke(self):
                return None

        for delay in (0.05, 0.3, 1.0):
            with self.subTest(delay=delay):
                controls = {
                    "status": FakeControl("대기"),
                    "team": FakeControl("기존팀"),
                    "map": FakeControl("중형-Basic"),
                    "people": FakeControl("2명"),
                    "info": FakeControl(),
                }
                timers = []

                class DelayedInfoApi:
                    def send(self, _room_id, map_name, team_name, _people):
                        timer = threading.Timer(
                            delay,
                            lambda: (
                                setattr(controls["team"], "value", team_name),
                                setattr(controls["map"], "value", map_name),
                            ),
                        )
                        timers.append(timer)
                        timer.start()
                        return 215

                ui = ManagerUI("manager", info_api=DelayedInfoApi())
                ui._window = lambda: object()
                ui._map_options["0"] = ui._fallback_map_options("0")
                ui._room_controls = lambda _window, _room_id, names: {
                    name: controls[name] for name in names
                }
                try:
                    ui._set_room_info_api(object(), "0", "새팀", 2, 2, True)
                finally:
                    for timer in timers:
                        timer.join(timeout=2.0)

                self.assertEqual(controls["team"].value, "새팀")
                self.assertEqual(controls["map"].value, "중형-Easy")

    def test_set_info_verification_classifies_team_and_exact_map_failures(self):
        class FakeControl:
            def __init__(self, value):
                self.value = value

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

        cases = (
            ("다른팀", "중형-Easy", "TEAM_VERIFY_FAILED"),
            ("새팀", "대형-산타맵", "MAP_VERIFY_FAILED"),
            ("다른팀", "대형-산타맵", "TEAM_AND_MAP_VERIFY_FAILED"),
        )
        for actual_team, actual_map, error_code in cases:
            with self.subTest(error_code=error_code):
                controls = {
                    "status": FakeControl("대기"),
                    "team": FakeControl(actual_team),
                    "map": FakeControl(actual_map),
                    "people": FakeControl("2명"),
                }
                ui = ManagerUI("manager")
                ui._window = lambda: object()
                ui._map_options["0"] = ui._fallback_map_options("0")
                ui._room_controls = lambda _window, _room_id, names: {
                    name: controls[name] for name in names
                }
                with patch("jumping_bridge.SET_INFO_VERIFY_SKIP_SECONDS", 0.03), patch(
                    "jumping_bridge.SET_INFO_VERIFY_POLL_SECONDS", 0.005
                ):
                    with self.assertRaises(SetInfoVerificationError) as caught:
                        ui._verify_set_info_applied(
                            "0", "새팀", "중형-Easy", 2, "2명", True
                        )
                self.assertEqual(caught.exception.error_code, error_code)

    def test_team_normalization_is_canonical_but_not_compatibility_matching(self):
        self.assertEqual(
            ManagerUI._normalize_team_for_compare("새팀"),
            ManagerUI._normalize_team_for_compare("새팀"),
        )
        self.assertNotEqual(
            ManagerUI._normalize_team_for_compare("Ａ팀"),
            ManagerUI._normalize_team_for_compare("A팀"),
        )

    def test_b1_large_and_medium_same_suffix_are_not_partial_matches(self):
        class FakeControl:
            def __init__(self, value):
                self.value = value

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

        controls = {
            "status": FakeControl("대기"),
            "team": FakeControl("새팀"),
            "map": FakeControl("대형-산타맵"),
            "people": FakeControl("2명"),
        }
        ui = ManagerUI("manager")
        ui._window = lambda: object()
        ui._map_options["2"] = ui._fallback_map_options("2")
        ui._room_controls = lambda _window, _room_id, names: {
            name: controls[name] for name in names
        }
        with patch("jumping_bridge.SET_INFO_VERIFY_SKIP_SECONDS", 0.03), patch(
            "jumping_bridge.SET_INFO_VERIFY_POLL_SECONDS", 0.005
        ):
            with self.assertRaises(SetInfoVerificationError) as caught:
                ui._verify_set_info_applied(
                    "2", "새팀", "중형-산타맵", 19, "2명", True
                )
        self.assertEqual(caught.exception.error_code, "MAP_VERIFY_FAILED")

    def test_set_info_state_read_failure_is_global_and_not_uia_fallback(self):
        ui = ManagerUI("manager")
        ui._window = lambda: (_ for _ in ()).throw(RuntimeError("no state"))
        with patch("jumping_bridge.SET_INFO_VERIFY_SKIP_SECONDS", 0.03), patch(
            "jumping_bridge.SET_INFO_VERIFY_POLL_SECONDS", 0.005
        ):
            with self.assertRaises(ManagerStateUnavailableError):
                ui._verify_set_info_applied(
                    "0", "새팀", "중형-Easy", 2, "2명", True
                )

    def test_set_info_room_control_read_failure_is_room_scoped(self):
        ui = ManagerUI("manager")
        ui._window = lambda: object()
        ui._room_controls = lambda *_args: (_ for _ in ()).throw(
            RuntimeError("room controls unavailable")
        )
        with patch("jumping_bridge.SET_INFO_VERIFY_SKIP_SECONDS", 0.03), patch(
            "jumping_bridge.SET_INFO_VERIFY_POLL_SECONDS", 0.005
        ):
            with self.assertRaises(RoomStateReadError) as caught:
                ui._verify_set_info_applied(
                    "0", "새팀", "중형-Easy", 2, "2명", True
                )

        self.assertEqual(caught.exception.error_code, "STATE_READ_FAILED")
        self.assertEqual(caught.exception.scope, "room")
        self.assertEqual(caught.exception.room_control_state, "SET_INFO_FAILED")

    def test_non_skip_people_unreadable_is_people_verify_failed(self):
        class FakeControl:
            def __init__(self, value):
                self.value = value

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

        class UnreadableControl:
            pass

        controls = {
            "status": FakeControl("대기"),
            "team": FakeControl("새팀"),
            "map": FakeControl("중형-Easy"),
            "people": UnreadableControl(),
        }
        ui = ManagerUI("manager")
        ui._window = lambda: object()
        ui._map_options["0"] = ui._fallback_map_options("0")
        ui._room_controls = lambda _window, _room_id, names: {
            name: controls[name] for name in names
        }
        with patch("jumping_bridge.SET_INFO_VERIFY_SECONDS", 0.03), patch(
            "jumping_bridge.SET_INFO_VERIFY_POLL_SECONDS", 0.005
        ):
            with self.assertRaises(SetInfoVerificationError) as caught:
                ui._verify_set_info_applied(
                    "0", "새팀", "중형-Easy", 2, "2명", False
                )

        self.assertEqual(caught.exception.error_code, "PEOPLE_VERIFY_FAILED")

    def test_set_info_empty_status_is_state_read_failure(self):
        class FakeControl:
            def __init__(self, value):
                self.value = value

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

        controls = {
            "status": FakeControl(""),
            "team": FakeControl("새팀"),
            "map": FakeControl("중형-Easy"),
            "people": FakeControl("2명"),
        }
        ui = ManagerUI("manager")
        ui._window = lambda: object()
        ui._map_options["0"] = ui._fallback_map_options("0")
        ui._room_controls = lambda _window, _room_id, names: {
            name: controls[name] for name in names
        }
        with patch("jumping_bridge.SET_INFO_VERIFY_SKIP_SECONDS", 0.03), patch(
            "jumping_bridge.SET_INFO_VERIFY_POLL_SECONDS", 0.005
        ):
            with self.assertRaises(RoomStateReadError):
                ui._verify_set_info_applied(
                    "0", "새팀", "중형-Easy", 2, "2명", True
                )

    def test_set_info_actual_team_is_not_truncated_before_exact_match(self):
        class FakeControl:
            def __init__(self, value):
                self.value = value

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

        controls = {
            "status": FakeControl("대기"),
            "team": FakeControl("abcdefghijX"),
            "map": FakeControl("중형-Easy"),
            "people": FakeControl("2명"),
        }
        ui = ManagerUI("manager")
        ui._window = lambda: object()
        ui._map_options["0"] = ui._fallback_map_options("0")
        ui._room_controls = lambda _window, _room_id, names: {
            name: controls[name] for name in names
        }
        with patch("jumping_bridge.SET_INFO_VERIFY_SKIP_SECONDS", 0.03), patch(
            "jumping_bridge.SET_INFO_VERIFY_POLL_SECONDS", 0.005
        ):
            with self.assertRaises(SetInfoVerificationError) as caught:
                ui._verify_set_info_applied(
                    "0", "abcdefghij", "중형-Easy", 2, "2명", True
                )

        self.assertEqual(caught.exception.error_code, "TEAM_VERIFY_FAILED")

    def test_api_verify_mismatch_runs_uia_then_fresh_exact_verify(self):
        class FakeControl:
            def __init__(self, value):
                self.value = value

            def get_value(self):
                return self.value

            def selected_text(self):
                return self.value

        controls = {
            "status": FakeControl("대기"),
            "team": FakeControl("기존팀"),
            "map": FakeControl("중형-Basic"),
            "people": FakeControl("2명"),
        }
        ui = ManagerUI("manager")
        ui._window = lambda: object()
        ui._map_options["0"] = ui._fallback_map_options("0")
        ui._room_controls = lambda _window, _room_id, names: {
            name: controls[name] for name in names
        }
        ui._set_room_info_api = lambda *_args: (_ for _ in ()).throw(
            SetInfoVerificationError(
                "mismatch",
                error_code="TEAM_AND_MAP_VERIFY_FAILED",
                attempts=3,
                team_ok=False,
                map_ok=False,
            )
        )

        def apply_uia(*_args):
            controls["team"].value = "새팀"
            controls["map"].value = "중형-Easy"

        ui._set_room_info_uia = apply_uia
        ui.set_room_info("0", "새팀", 2, 2, True)

        self.assertEqual(controls["team"].value, "새팀")
        self.assertEqual(controls["map"].value, "중형-Easy")

    def test_bridge_skip_people_delegates_fresh_people_read_to_manager_ui(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=False, armed=True),
                Path(folder) / "state.json",
            )
            bridge.state.rooms["0"].people = 4
            calls = []
            bridge.ui.set_room_info = lambda *args: calls.append(args)

            bridge._execute(
                {
                    "roomId": "0",
                    "action": "set_info",
                    "payload": {
                        "teamName": "새팀",
                        "mapIndex": 2,
                        "people": 9,
                        "skipPeople": True,
                    },
                }
            )

            self.assertEqual(calls, [("0", "새팀", 2, 0, True)])
            self.assertEqual(bridge.state.rooms["0"].people, 4)

    def test_manager_controls_filter_automation_id_and_sort_by_position(self):
        class FakeRectangle:
            def __init__(self, top, left):
                self.top = top
                self.left = left

        class FakeControl:
            def __init__(self, automation_id, top):
                self.element_info = type(
                    "ElementInfo", (), {"automation_id": automation_id}
                )()
                self._rectangle = FakeRectangle(top, 10)

            def rectangle(self):
                return self._rectangle

        expected_id = f"{PANEL_AUTO_ID}.ui_label_title"
        controls = [
            FakeControl(expected_id, 400),
            FakeControl("unrelated", 50),
            FakeControl(expected_id, 100),
            FakeControl(expected_id, 300),
            FakeControl(expected_id, 200),
        ]

        class FakeWindow:
            def descendants(self, **criteria):
                self.criteria = criteria
                return controls

        window = FakeWindow()
        result = ManagerUI("manager")._controls(window, "title")

        self.assertEqual(window.criteria, {"control_type": "Text"})
        self.assertEqual([item.rectangle().top for item in result], [100, 200, 300, 400])

    def test_people_index_uses_qt_visible_value(self):
        self.assertEqual(ManagerUI._people_index("?명"), 0)
        self.assertEqual(ManagerUI._people_index("3명"), 3)
        self.assertEqual(ManagerUI._people_index("9명"), 9)
        self.assertEqual(ManagerUI._people_index("기타"), 10)
        self.assertEqual(ManagerUI._people_index("unknown"), 0)

    def test_running_room_never_opens_map_combo_for_discovery(self):
        ui = ManagerUI("manager")
        calls = []
        ui._combo_options = lambda combo: calls.append(combo) or ["소형-Basic"]
        running_combo = object()

        ui._ensure_map_options("1", running_combo, "running")

        self.assertEqual(calls, [])
        self.assertNotIn("1", ui._map_options)

        waiting_combo = object()
        ui._ensure_map_options("3", waiting_combo, "waiting")
        self.assertEqual(calls, [waiting_combo])
        self.assertNotIn("1", ui._map_options)
        self.assertEqual(ui._map_options["3"], ["소형-Basic"])

    def test_stop_confirmation_requires_exact_qt_dialog(self):
        class FakeElementInfo:
            def __init__(self, class_name):
                self.class_name = class_name

        class FakeControl:
            def __init__(self, text):
                self.text = text
                self.clicked = False

            def window_text(self):
                return self.text

            def invoke(self):
                self.clicked = True

        class FakeDialog(FakeControl):
            def __init__(self, title, class_name, messages, buttons):
                super().__init__(title)
                self.element_info = FakeElementInfo(class_name)
                self.messages = [FakeControl(message) for message in messages]
                self.buttons = [FakeControl(button) for button in buttons]

            def descendants(self, control_type):
                return self.messages if control_type == "Text" else self.buttons

        verified = FakeDialog(
            "알림", "QMessageBox", ["정말 정지 할까요?"], ["취소", "예"]
        )
        button = ManagerUI._verified_stop_button(verified)
        self.assertIsNotNone(button)
        self.assertEqual(button.window_text(), "예")

        wrong_message = FakeDialog(
            "알림", "QMessageBox", ["다른 작업을 실행할까요?"], ["취소", "예"]
        )
        self.assertIsNone(ManagerUI._verified_stop_button(wrong_message))

        ambiguous = FakeDialog(
            "알림", "QMessageBox", ["정말 정지 할까요?"], ["취소", "예", "예"]
        )
        self.assertIsNone(ManagerUI._verified_stop_button(ambiguous))

    def test_start_and_stop_room_failures_are_room_scoped(self):
        for action in ("start", "stop"):
            with self.subTest(action=action):
                ui = ManagerUI("manager")
                ui._window = lambda *_args: object()
                ui._control = lambda *_args: (_ for _ in ()).throw(
                    RuntimeError("room control unavailable")
                )

                with self.assertRaises(RoomControlError) as caught:
                    getattr(ui, action)("0")

                self.assertEqual(caught.exception.scope, "room")
                self.assertEqual(
                    caught.exception.error_code,
                    "START_FAILED" if action == "start" else "STOP_FAILED",
                )
                self.assertEqual(
                    caught.exception.room_control_state,
                    "CONTROL_FAILED",
                )

    def test_start_and_stop_window_failures_are_global(self):
        for action in ("start", "stop"):
            with self.subTest(action=action):
                ui = ManagerUI("manager")
                ui._window = lambda *_args: (_ for _ in ()).throw(
                    RuntimeError("manager window unavailable")
                )

                with self.assertRaises(ManagerStateUnavailableError):
                    getattr(ui, action)("0")

    def test_start_and_stop_empty_status_fail_closed_as_room_state_read_error(self):
        class EmptyStatus:
            def window_text(self):
                return ""

        for action in ("start", "stop"):
            with self.subTest(action=action):
                ui = ManagerUI("manager")
                ui._window = lambda *_args, **_kwargs: object()
                ui._control = (
                    lambda _window, _room_id, name: EmptyStatus()
                    if name == "status"
                    else object()
                )

                with self.assertRaises(RoomStateReadError) as caught:
                    getattr(ui, action)("0")

                self.assertEqual(caught.exception.scope, "room")
                self.assertEqual(caught.exception.error_code, "STATE_READ_FAILED")

    def test_stop_does_not_treat_empty_status_after_confirmation_as_success(self):
        class FakeElementInfo:
            process_id = 4321

        class FakeWindow:
            element_info = FakeElementInfo()
            handle = 9876

        class FakeStatus:
            text = "게임중"

            def window_text(self):
                return self.text

        status = FakeStatus()
        ui = ManagerUI("manager")
        ui._window = lambda *_args, **_kwargs: FakeWindow()
        ui._control = lambda _window, _room_id, name: (
            status if name == "status" else object()
        )

        def trigger(*args):
            finished = args[5]
            finished.set()

        def watcher(*args):
            confirmed = args[5]
            status.text = ""
            confirmed.set()

        ui._trigger_stop_control = trigger
        ui._watch_stop_dialog = watcher

        with self.assertRaises(RoomStateReadError) as caught:
            ui.stop("0")

        self.assertEqual(caught.exception.error_code, "STATE_READ_FAILED")

    def test_stop_watcher_confirms_while_trigger_is_still_running(self):
        class FakeElementInfo:
            process_id = 4321

        class FakeWindow:
            element_info = FakeElementInfo()
            handle = 9876

        class FakeStatus:
            text = "게임중"

            def window_text(self):
                return self.text

        status = FakeStatus()
        ui = ManagerUI("manager")
        ui._window = lambda *_args, **_kwargs: FakeWindow()
        ui._control = lambda _window, _room_id, name: status if name == "status" else object()
        trigger_released = threading.Event()

        def trigger(
            _process_id,
            _window_handle,
            _room_id,
            _command_id,
            _started_at,
            finished,
            _errors,
            _perf_trace,
        ):
            trigger_released.wait(1.0)
            finished.set()

        def watcher(
            _process_id,
            _window_handle,
            _command_id,
            _started_at,
            _cancel,
            confirmed,
            _errors,
            _perf_trace,
        ):
            time.sleep(0.05)
            status.text = "대기"
            confirmed.set()
            trigger_released.set()

        ui._trigger_stop_control = trigger
        ui._watch_stop_dialog = watcher

        ui.stop("0")

        self.assertTrue(trigger_released.is_set())
        self.assertEqual(status.text, "대기")

    def test_stop_timeout_returns_without_waiting_for_blocked_trigger(self):
        class FakeElementInfo:
            process_id = 4321

        class FakeWindow:
            element_info = FakeElementInfo()
            handle = 9876

        class FakeStatus:
            def window_text(self):
                return "게임중"

        ui = ManagerUI("manager")
        ui._window = lambda *_args, **_kwargs: FakeWindow()
        ui._control = lambda _window, _room_id, name: FakeStatus() if name == "status" else object()

        def blocked_trigger(*_args):
            time.sleep(1.0)

        def missing_dialog(*args):
            cancel = args[4]
            cancel.wait(1.0)

        ui._trigger_stop_control = blocked_trigger
        ui._watch_stop_dialog = missing_dialog

        started = time.monotonic()
        with patch("jumping_bridge.STOP_DIALOG_TIMEOUT_SECONDS", 0.1):
            with self.assertRaisesRegex(RuntimeError, "정지 확인이 필요합니다"):
                ui.stop("0")

        self.assertLess(time.monotonic() - started, 0.5)

    def test_stop_watcher_searches_manager_child_windows(self):
        class FakeElementInfo:
            def __init__(self, class_name=""):
                self.class_name = class_name

        class FakeControl:
            def __init__(self, text):
                self.text = text
                self.clicked = False

            def window_text(self):
                return self.text

            def invoke(self):
                self.clicked = True

        class FakeDialog(FakeControl):
            def __init__(self):
                super().__init__("알림")
                self.element_info = FakeElementInfo("QMessageBox")
                self.message = FakeControl("정말 정지 할까요?")
                self.yes = FakeControl("예")
                self.cancel = FakeControl("취소")

            def descendants(self, control_type):
                if control_type == "Text":
                    return [self.message]
                if control_type == "Button":
                    return [self.cancel, self.yes]
                return []

        class FakeManagerWindow:
            def __init__(self, dialog):
                self.dialog = dialog
                self.child_searches = 0

            def descendants(self, control_type):
                self.child_searches += 1
                return [self.dialog] if control_type == "Window" else []

        class EmptyDesktop:
            def __init__(self, backend):
                self.backend = backend

            def windows(self, process):
                return []

        dialog = FakeDialog()
        manager_window = FakeManagerWindow(dialog)
        confirmed = threading.Event()
        errors = []
        ui = ManagerUI("manager")
        ui._process_window = lambda _process_id, _window_handle: manager_window
        ui._initialize_automation_thread = lambda: (lambda: None)

        with patch("pywinauto.Desktop", EmptyDesktop):
            ui._watch_stop_dialog(
                4321,
                9876,
                "CTRL-CHILD-DIALOG",
                time.perf_counter(),
                threading.Event(),
                confirmed,
                errors,
                None,
            )

        self.assertTrue(confirmed.is_set())
        self.assertTrue(dialog.yes.clicked)
        self.assertGreater(manager_window.child_searches, 0)
        self.assertEqual(errors, [])

    def test_combo_selection_uses_uia_without_mouse_input(self):
        class FakeItem:
            def __init__(self, combo, text):
                self.combo = combo
                self.text = text

            def window_text(self):
                return self.text

            def select(self):
                self.combo.value = self.text

            def invoke(self):
                self.combo.value = self.text

        class FakeCombo:
            def __init__(self):
                self.value = "기존값"
                self.mouse_was_used = False
                self.options = ["2명", "3명"]
                self.index = 0

            def selected_text(self):
                return self.value

            def expand(self):
                pass

            def collapse(self):
                pass

            def descendants(self, control_type):
                return [FakeItem(self, "2명"), FakeItem(self, "3명")]

            def set_focus(self):
                pass

            def type_keys(self, keys):
                self.index = 0
                match = re.search(r"\{DOWN (\d+)\}", keys)
                if match:
                    self.index += int(match.group(1))
                if keys.endswith("{ENTER}"):
                    self.value = self.options[self.index]

            def click_input(self):
                self.mouse_was_used = True

        combo = FakeCombo()
        ManagerUI("manager")._select_combo_text(combo, "3명", "선택 실패")

        self.assertEqual(combo.value, "3명")
        self.assertFalse(combo.mouse_was_used)

    def test_exact_popup_item_is_scrolled_into_view_before_commit(self):
        calls = []

        class FakeItem:
            def scroll_into_view(self):
                calls.append("scroll")

            def select(self):
                calls.append("select")

            def set_focus(self):
                calls.append("focus")

            def type_keys(self, keys):
                calls.append(keys)

        ManagerUI._activate_popup_item(FakeItem())

        self.assertEqual(calls, ["scroll", "select", "focus", "{ENTER}"])

    def test_combo_keyboard_confirms_when_qt_value_is_blank(self):
        class FakeItem:
            def __init__(self, text):
                self.text = text

            def window_text(self):
                return self.text

            def select(self):
                raise AssertionError("SelectionItem must not be trusted")

            def invoke(self):
                raise AssertionError("Invoke must not be trusted")

            def is_selected(self):
                return False

        class FakeCombo:
            def __init__(self):
                self.items = [FakeItem("중형-Basic"), FakeItem("중형-Easy")]
                self.keys = []

            def selected_text(self):
                return ""

            def window_text(self):
                return ""

            def expand(self):
                pass

            def collapse(self):
                pass

            def descendants(self, control_type):
                return self.items

            def set_focus(self):
                pass

            def type_keys(self, keys):
                self.keys.append(keys)

        combo = FakeCombo()
        ManagerUI("manager")._select_combo_text(
            combo,
            "중형-Easy",
            "선택 실패",
        )

        self.assertEqual(combo.keys, ["{HOME}{DOWN 1}{ENTER}"])

    def test_each_room_uses_its_own_map_size(self):
        ui = ManagerUI("manager")
        ui._combo_options = lambda _combo: ["중형-Basic", "중형-Easy"]

        ui._ensure_map_options("2", object(), "waiting")

        self.assertEqual(ui._map_options["2"][0], "대형-Basic")
        self.assertEqual(ui._map_options["2"][4], "대형-챌린저")
        self.assertEqual(ui._map_options["2"][10], "중형-Basic")
        self.assertEqual(ui._map_options["2"][14], "중형-챌린저")
        self.assertEqual(len(ui._map_options["2"]), 20)
        self.assertNotIn("0", ui._map_options)

    def test_b1_combo_index_matches_large_then_medium_manager_order(self):
        self.assertEqual(ManagerUI._map_combo_index("0", 1), 0)
        self.assertEqual(ManagerUI._map_combo_index("1", 5), 4)
        self.assertEqual(ManagerUI._map_combo_index("2", 1), 0)
        self.assertEqual(ManagerUI._map_combo_index("2", 5), 4)
        self.assertEqual(ManagerUI._map_combo_index("2", 11), 10)
        self.assertEqual(ManagerUI._map_combo_index("2", 15), 14)
        self.assertEqual(ManagerUI._map_combo_index("3", 9), 8)

    def test_b1_medium_mode_name_is_preserved(self):
        ui = ManagerUI("manager")

        self.assertEqual(
            ui._normalize_map_name("2", "중형-Normal"), "중형-Normal"
        )
        self.assertEqual(
            ui._normalize_map_name("0", "중형-Normal"), "중형-Normal"
        )

    def test_combo_verification_accepts_known_qt_alias(self):
        class FakeCombo:
            def selected_text(self):
                return "중형-Normal"

        ui = ManagerUI("manager")

        self.assertTrue(
            ui._combo_selection_state(
                FakeCombo(), "대형-Normal", {"중형-Normal"}
            )
        )

    def test_exact_visible_popup_item_is_activated_without_index_navigation(self):
        class FakeItem:
            def __init__(self, combo, text):
                self.combo = combo
                self.text = text

            def window_text(self):
                return self.text

            def select(self):
                pass

            def set_focus(self):
                pass

            def type_keys(self, keys):
                if keys == "{ENTER}":
                    self.combo.value = self.text

        class RotatedCombo:
            def __init__(self):
                self.value = "대형-Normal"
                self.items = [
                    FakeItem(self, "대형-HARD"),
                    FakeItem(self, "대형-챌린저"),
                    FakeItem(self, "대형-키즈맵"),
                    FakeItem(self, "중형-Basic"),
                ]

            def selected_text(self):
                return self.value

            def expand(self):
                pass

            def collapse(self):
                pass

            def descendants(self, control_type):
                return self.items

        combo = RotatedCombo()

        ManagerUI("manager")._select_combo_text(
            combo, "대형-키즈맵", "선택 실패", fallback_index=17
        )

        self.assertEqual(combo.value, "대형-키즈맵")

    def test_map_keyboard_fallback_targets_requested_index(self):
        class WrongPopupItem:
            def __init__(self, text):
                self.text = text

            def window_text(self):
                return self.text

        class FakeCombo:
            def __init__(self):
                self.value = ""
                self.keys = []

            def selected_text(self):
                return self.value

            def window_text(self):
                return self.value

            def expand(self):
                pass

            def collapse(self):
                pass

            def set_focus(self):
                pass

            def type_keys(self, keys):
                self.keys.append(keys)
                if keys.endswith("{ENTER}"):
                    self.value = "대형-챌린저"

            def descendants(self, control_type):
                return [WrongPopupItem("중형-Basic"), WrongPopupItem("중형-챌린저")]

        combo = FakeCombo()
        ManagerUI("manager")._select_combo_text(
            combo,
            "대형-챌린저",
            "선택 실패",
            fallback_index=4,
        )

        self.assertEqual(combo.value, "대형-챌린저")
        self.assertEqual(combo.keys, ["{HOME}{DOWN 4}{ENTER}"])

    def test_button_invocation_uses_uia_without_mouse_input(self):
        class FakeButton:
            invoked = False
            mouse_was_used = False

            def invoke(self):
                self.invoked = True

            def click_input(self):
                self.mouse_was_used = True

        button = FakeButton()
        ManagerUI._invoke_control(button, "실행 실패")

        self.assertTrue(button.invoked)
        self.assertFalse(button.mouse_was_used)

    def test_button_fallback_uses_window_message_without_mouse_input(self):
        class FakeButton:
            message_clicked = False
            mouse_was_used = False

            def invoke(self):
                raise RuntimeError("invoke unavailable")

            def click(self):
                self.message_clicked = True

            def click_input(self):
                self.mouse_was_used = True

        button = FakeButton()
        ManagerUI._invoke_control(button, "실행 실패")

        self.assertTrue(button.message_clicked)
        self.assertFalse(button.mouse_was_used)

    def test_heartbeat_does_not_wait_for_manager_automation_lock(self):
        class FakeHeartbeatRemote:
            def __init__(self):
                self.called = threading.Event()
                self.payloads = []

            def heartbeat(self, agent_id, instance_id, payload):
                self.payloads.append((agent_id, instance_id, payload))
                self.called.set()

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, heartbeat_seconds=1.0),
                Path(folder) / "state.json",
            )
            fake_remote = FakeHeartbeatRemote()
            bridge.heartbeat_remote = fake_remote
            bridge._manager_io_lock.acquire()
            thread = threading.Thread(target=bridge._heartbeat_loop, daemon=True)
            thread.start()
            try:
                self.assertTrue(fake_remote.called.wait(0.5))
                self.assertEqual(fake_remote.payloads[0][2]["controlState"], "IDLE")
                self.assertGreater(bridge._last_heartbeat_success_monotonic, 0)
            finally:
                bridge.stop_event.set()
                bridge._manager_io_lock.release()
                thread.join(timeout=1.0)
                bridge.close()

    def test_room_set_info_failure_does_not_set_global_error_or_other_rooms(self):
        command = {
            "id": "room-set-info-failure",
            "roomId": "0",
            "action": "set_info",
            "payload": {"teamName": "테스트", "mapIndex": 2},
        }
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            remote = FakeRemote(command)

            def fail_room(_command, _trace=None):
                raise SetInfoVerificationError(
                    "팀명과 맵 불일치",
                    error_code="TEAM_AND_MAP_VERIFY_FAILED",
                    attempts=4,
                    team_ok=False,
                    map_ok=False,
                )

            bridge._execute = fail_room
            bridge._process_commands([command], remote)
            status = bridge._control_status_snapshot()
            states = {item["roomId"]: item for item in status["roomControlStates"]}

            self.assertEqual(status["controlState"], "DEGRADED")
            self.assertEqual(states["0"]["state"], "SET_INFO_FAILED")
            self.assertEqual(
                states["0"]["errorCode"], "TEAM_AND_MAP_VERIFY_FAILED"
            )
            self.assertEqual(states["1"]["state"], "READY")
            self.assertEqual(states["2"]["state"], "READY")
            self.assertEqual(states["3"]["state"], "READY")
            self.assertEqual(remote.acks[0][1], "failed")
            self.assertEqual(
                remote.ack_metadata[0]["error_code"],
                "TEAM_AND_MAP_VERIFY_FAILED",
            )
            self.assertEqual(
                remote.ack_metadata[0]["room_control_state"],
                "SET_INFO_FAILED",
            )
            bridge.close()

    def test_manager_state_failure_sets_global_error(self):
        command = {
            "id": "manager-state-failure",
            "roomId": "0",
            "action": "set_info",
            "payload": {},
        }
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            remote = FakeRemote(command)
            bridge._execute = lambda *_args: (_ for _ in ()).throw(
                ManagerStateUnavailableError("Manager 상태 없음")
            )

            bridge._process_commands([command], remote)

            self.assertEqual(
                bridge._control_status_snapshot()["controlState"], "ERROR"
            )
            self.assertEqual(
                remote.ack_metadata[0]["error_code"],
                "MANAGER_STATE_UNAVAILABLE",
            )
            bridge.close()

    def test_start_set_info_failure_is_reported_as_set_info_failed(self):
        command = {
            "id": "start-set-info-failure",
            "roomId": "0",
            "action": "start",
            "payload": {},
        }
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            remote = FakeRemote(command)
            bridge._execute = lambda *_args: (_ for _ in ()).throw(
                SetInfoVerificationError(
                    "map mismatch",
                    error_code="MAP_VERIFY_FAILED",
                    attempts=2,
                    team_ok=True,
                    map_ok=False,
                )
            )

            bridge._process_commands([command], remote)

            room_state = next(
                item
                for item in bridge._control_status_snapshot()["roomControlStates"]
                if item["roomId"] == "0"
            )
            self.assertEqual(room_state["state"], "SET_INFO_FAILED")
            self.assertEqual(
                remote.ack_metadata[0]["room_control_state"],
                "SET_INFO_FAILED",
            )
            bridge.close()

    def test_generic_room_actuation_failure_is_control_failed(self):
        command = {
            "id": "room-stop-failure",
            "roomId": "1",
            "action": "stop",
            "payload": {},
        }
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            remote = FakeRemote(command)
            bridge._execute = lambda *_args: (_ for _ in ()).throw(
                RoomControlError("stop failed", error_code="STOP_FAILED")
            )

            bridge._process_commands([command], remote)

            room_state = next(
                item
                for item in bridge._control_status_snapshot()["roomControlStates"]
                if item["roomId"] == "1"
            )
            self.assertEqual(room_state["state"], "CONTROL_FAILED")
            self.assertEqual(
                remote.ack_metadata[0]["room_control_state"],
                "CONTROL_FAILED",
            )
            bridge.close()

    def test_global_failure_blocks_later_manager_but_not_payment_in_same_batch(self):
        commands = [
            {"id": "global-failure", "roomId": "0", "action": "set_info", "payload": {}},
            {"id": "later-manager", "roomId": "1", "action": "set_info", "payload": {}},
            {
                "id": "payment-after-control-failure",
                "roomId": "PAYMENT",
                "action": "payment_status",
                "payload": {
                    "transactionUuid": "tx-after-control-failure",
                    "amount": 1000,
                },
            },
        ]
        with tempfile.TemporaryDirectory() as folder:
            payment = FakePaymentService()
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
                payment_service=payment,
            )
            remote = FakeRemote(commands[0])
            manager_calls = []

            def execute(command, _trace=None):
                manager_calls.append(command["id"])
                raise ManagerStateUnavailableError("Manager unavailable")

            bridge._execute = execute
            bridge._process_commands(commands, remote)

            self.assertEqual(manager_calls, ["global-failure"])
            self.assertEqual(payment.execute_calls, 1)
            self.assertEqual(
                bridge.state.processed_commands["later-manager"]["status"], "failed"
            )
            self.assertEqual(
                bridge.state.processed_commands["later-manager"]["errorCode"],
                "CONTROL_BATCH_BLOCKED",
            )
            self.assertEqual(
                bridge.state.processed_commands["payment-after-control-failure"]["status"],
                "completed",
            )
            self.assertFalse(bridge._claimed_control_command_ids)
            bridge.close()

    def test_existing_global_error_blocks_new_manager_but_not_payment(self):
        commands = [
            {"id": "manager-while-error", "roomId": "0", "action": "set_info", "payload": {}},
            {
                "id": "payment-while-error",
                "roomId": "PAYMENT",
                "action": "payment_status",
                "payload": {
                    "transactionUuid": "tx-while-control-error",
                    "amount": 1000,
                },
            },
        ]
        with tempfile.TemporaryDirectory() as folder:
            payment = FakePaymentService()
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
                payment_service=payment,
            )
            bridge._set_control_status("ERROR", error="Manager unavailable")
            manager_calls = []
            bridge._execute = lambda command, _trace=None: manager_calls.append(command["id"])
            remote = FakeRemote(commands[0])

            bridge._process_commands(commands, remote)

            self.assertEqual(manager_calls, [])
            self.assertEqual(payment.execute_calls, 1)
            self.assertEqual(
                bridge.state.processed_commands["manager-while-error"]["status"],
                "failed",
            )
            self.assertEqual(
                bridge.state.processed_commands["manager-while-error"]["errorCode"],
                "CONTROL_BATCH_BLOCKED",
            )
            self.assertEqual(
                bridge.state.processed_commands["payment-while-error"]["status"],
                "completed",
            )
            self.assertEqual(
                bridge._control_status_snapshot()["controlState"], "ERROR"
            )
            bridge.close()

    def test_degraded_control_allows_new_explicit_manager_command(self):
        command = {
            "id": "manager-while-degraded",
            "roomId": "0",
            "action": "set_info",
            "payload": {},
        }
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            bridge._set_control_status("DEGRADED", error="C2 prior failure")
            manager_calls = []

            def execute(value, _trace=None):
                manager_calls.append(value["id"])
                return bridge.state.rooms["0"]

            bridge._execute = execute
            remote = FakeRemote(command)

            bridge._process_commands([command], remote)

            self.assertEqual(manager_calls, ["manager-while-degraded"])
            self.assertEqual(
                bridge.state.processed_commands[command["id"]]["status"],
                "completed",
            )
            self.assertEqual(remote.acks[0][1], "completed")
            self.assertEqual(
                bridge._control_status_snapshot()["controlState"], "DEGRADED"
            )
            bridge.close()

    def test_room_failure_does_not_block_later_manager_in_same_batch(self):
        commands = [
            {"id": "room-failure", "roomId": "0", "action": "set_info", "payload": {}},
            {"id": "other-room", "roomId": "1", "action": "set_info", "payload": {}},
        ]
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            remote = FakeRemote(commands[0])
            manager_calls = []

            def execute(command, _trace=None):
                manager_calls.append(command["id"])
                if command["id"] == "room-failure":
                    raise SetInfoVerificationError(
                        "team mismatch",
                        error_code="TEAM_VERIFY_FAILED",
                        attempts=2,
                        team_ok=False,
                        map_ok=True,
                    )
                return bridge.state.rooms["1"]

            bridge._execute = execute
            bridge._process_commands(commands, remote)

            self.assertEqual(manager_calls, ["room-failure", "other-room"])
            self.assertEqual(
                bridge.state.processed_commands["other-room"]["status"], "completed"
            )
            self.assertFalse(bridge._claimed_control_command_ids)
            bridge.close()

    def test_failed_ack_retry_preserves_room_failure_metadata_without_replay(self):
        command = {
            "id": "failed-ack-retry",
            "roomId": "0",
            "action": "set_info",
            "payload": {},
        }

        class FlakyAckRemote(FakeRemote):
            def __init__(self, value):
                super().__init__(value)
                self.attempts = 0

            def ack(self, *args, **metadata):
                self.attempts += 1
                if self.attempts == 1:
                    raise TimeoutError("ack timeout")
                return super().ack(*args, **metadata)

        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            remote = FlakyAckRemote(command)
            execute_calls = []

            def execute(_command, _trace=None):
                execute_calls.append(True)
                raise SetInfoVerificationError(
                    "team mismatch",
                    error_code="TEAM_VERIFY_FAILED",
                    attempts=2,
                    team_ok=False,
                    map_ok=True,
                )

            bridge._execute = execute
            bridge._process_commands([command], remote)
            self.assertTrue(
                bridge.state.processed_commands[command["id"]]["ackPending"]
            )
            bridge._flush_ack_outbox(remote, force=True)

            self.assertEqual(len(execute_calls), 1)
            self.assertFalse(
                bridge.state.processed_commands[command["id"]]["ackPending"]
            )
            self.assertEqual(remote.acks[0][1], "failed")
            self.assertEqual(
                remote.ack_metadata[0]["error_code"], "TEAM_VERIFY_FAILED"
            )
            self.assertEqual(remote.ack_metadata[0]["error_scope"], "room")
            self.assertEqual(
                remote.ack_metadata[0]["room_control_state"],
                "SET_INFO_FAILED",
            )
            bridge.close()

    def test_completed_ack_retry_never_replays_manager_command(self):
        command = {
            "id": "completed-ack-retry",
            "roomId": "0",
            "action": "set_info",
            "payload": {},
        }

        class FlakyAckRemote(FakeRemote):
            def __init__(self, value):
                super().__init__(value)
                self.attempts = 0

            def ack(self, *args, **metadata):
                self.attempts += 1
                if self.attempts == 1:
                    raise TimeoutError("ack timeout")
                return super().ack(*args, **metadata)

        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            remote = FlakyAckRemote(command)
            execute_calls = []

            def execute(_command, _trace=None):
                execute_calls.append(True)
                return bridge.state.rooms["0"]

            bridge._execute = execute
            bridge._process_commands([command], remote)

            self.assertEqual(len(execute_calls), 1)
            self.assertEqual(
                bridge.state.processed_commands[command["id"]]["status"],
                "completed",
            )
            self.assertTrue(
                bridge.state.processed_commands[command["id"]]["ackPending"]
            )

            bridge._flush_ack_outbox(remote, force=True)

            self.assertEqual(len(execute_calls), 1)
            self.assertEqual(remote.acks[0][1], "completed")
            self.assertFalse(
                bridge.state.processed_commands[command["id"]]["ackPending"]
            )
            self.assertEqual(
                bridge.state.processed_commands[command["id"]]["ackResolution"],
                "ACKED",
            )
            bridge.close()

    def test_ack_state_conflict_is_terminal_reconciliation_without_replay(self):
        command_id = "ack-state-conflict"

        class ConflictRemote(FakeRemote):
            def ack(self, *_args, **_metadata):
                raise RemoteResponseError(
                    409,
                    '{"errorCode":"ACK_STATE_CONFLICT"}',
                )

        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            original_room = bridge.state.rooms["0"].public_dict()
            bridge.state.mark_command(
                command_id,
                "completed",
                "매장 PC 처리 완료",
                "0",
                ack_pending=True,
                ack_room=original_room,
            )

            resolved = bridge._flush_ack_outbox(
                ConflictRemote({"id": command_id}),
                force=True,
            )
            stored = bridge.state.processed_commands[command_id]

            self.assertEqual(resolved, 1)
            self.assertEqual(stored["status"], "completed")
            self.assertEqual(stored["result"], "매장 PC 처리 완료")
            self.assertFalse(stored["ackPending"])
            self.assertEqual(stored["ackResolution"], "ACK_STATE_CONFLICT")
            self.assertFalse(bridge.state.has_unresolved_commands())
            bridge.close()

    def test_non_terminal_ack_error_remains_pending_without_replay(self):
        command_id = "ack-transient-conflict"

        class RejectedRemote(FakeRemote):
            def ack(self, *_args, **_metadata):
                raise RemoteResponseError(409, '{"errorCode":"OTHER_CONFLICT"}')

        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=True, armed=True),
                Path(folder) / "state.json",
            )
            bridge.state.mark_command(
                command_id,
                "failed",
                "기존 실행 실패",
                "0",
                error_code="TEAM_VERIFY_FAILED",
                error_scope="room",
                ack_pending=True,
            )

            resolved = bridge._flush_ack_outbox(
                RejectedRemote({"id": command_id}),
                force=True,
            )
            stored = bridge.state.processed_commands[command_id]

            self.assertEqual(resolved, 0)
            self.assertEqual(stored["status"], "failed")
            self.assertEqual(stored["result"], "기존 실행 실패")
            self.assertTrue(stored["ackPending"])
            self.assertEqual(stored["ackResolution"], "PENDING")
            self.assertTrue(bridge.state.has_unresolved_commands())
            bridge.close()

    def test_control_recovery_requires_two_safe_probes_and_keeps_failed_command(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(
                    simulate=True,
                    armed=True,
                    heartbeat_seconds=2.0,
                    control_poll_seconds=0.2,
                ),
                Path(folder) / "state.json",
            )
            bridge._set_room_control_error(
                "0",
                "set_info",
                "failed-command",
                "TEAM_VERIFY_FAILED",
                "팀명 불일치",
                "SET_INFO_FAILED",
            )
            bridge.state.mark_command(
                "failed-command", "failed", "팀명 불일치", "0"
            )
            bridge._set_control_status("DEGRADED", error="팀명 불일치")
            now = time.monotonic()
            bridge._last_heartbeat_success_monotonic = now
            bridge._control_loop_last_seen_monotonic = now
            bridge._control_loop_last_seen_at = datetime.now().astimezone().isoformat()
            bridge._last_state_refresh_at = now
            bridge.manager_visible = True
            bridge._manager_modal_active = False

            self.assertFalse(bridge._consider_control_recovery())
            self.assertEqual(
                bridge._control_status_snapshot()["controlState"], "DEGRADED"
            )
            self.assertTrue(bridge._consider_control_recovery())
            status = bridge._control_status_snapshot()

            self.assertEqual(status["controlState"], "IDLE")
            self.assertEqual(status["managerProbeSuccessCount"], 2)
            self.assertEqual(
                bridge.state.processed_commands["failed-command"]["status"],
                "failed",
            )
            room_state = next(
                item for item in status["roomControlStates"] if item["roomId"] == "0"
            )
            self.assertEqual(room_state["state"], "SET_INFO_FAILED")
            bridge.close()

    def test_control_recovery_is_blocked_by_modal_or_active_command(self):
        for blocker in (
            "modal",
            "command",
            "heartbeat",
            "claimed",
            "executing",
            "ack_pending",
        ):
            with self.subTest(blocker=blocker), tempfile.TemporaryDirectory() as folder:
                bridge = Bridge(
                    BridgeConfig(simulate=True, armed=True),
                    Path(folder) / "state.json",
                )
                bridge._set_control_status("ERROR", error="공통 오류")
                now = time.monotonic()
                bridge._last_heartbeat_success_monotonic = (
                    0.0 if blocker == "heartbeat" else now
                )
                bridge._control_loop_last_seen_monotonic = now
                bridge._last_state_refresh_at = now
                bridge.manager_visible = True
                bridge._manager_modal_active = blocker == "modal"
                if blocker == "command":
                    bridge._set_active_control("active-command", "0")
                elif blocker == "claimed":
                    bridge._claimed_control_command_ids.add("claimed-command")
                elif blocker == "executing":
                    bridge.state.mark_command(
                        "executing-command",
                        "executing",
                        "still executing",
                        "0",
                    )
                elif blocker == "ack_pending":
                    bridge.state.mark_command(
                        "ack-pending-command",
                        "completed",
                        "already executed",
                        "0",
                        ack_pending=True,
                    )

                self.assertFalse(bridge._consider_control_recovery())
                self.assertEqual(
                    bridge._control_status_snapshot()["controlState"], "ERROR"
                )
                bridge.close()

    def test_config_filters_unknown_values(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "server_url": "https://example.test",
                        "armed": False,
                        "unknown": "ignored",
                    }
                ),
                encoding="utf-8",
            )
            config = BridgeConfig.load(path)
            self.assertEqual(config.server_url, "https://example.test")
            self.assertFalse(config.armed)

    def test_config_accepts_windows_utf8_bom(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            path.write_text(
                json.dumps({"server_url": "https://example.test", "armed": True}),
                encoding="utf-8-sig",
            )

            config = BridgeConfig.load(path)

            self.assertEqual(config.server_url, "https://example.test")
            self.assertTrue(config.armed)

    def test_state_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            store = StateStore(path)
            store.rooms["0"].status = "running"
            store.rooms["0"].teamName = "테스트팀"
            store.mark_command(
                "command-1",
                "failed",
                "처리 실패",
                "0",
                error_code="MAP_VERIFY_FAILED",
                error_scope="room",
                room_control_state="SET_INFO_FAILED",
                ack_pending=True,
                ack_room=store.rooms["0"].public_dict(),
                trace_id="CTRL-state-round-trip",
                latency_events=[{"stage": "VERIFY_DONE", "elapsedMs": 125}],
            )
            store.save()
            loaded = StateStore(path)
            self.assertEqual(loaded.rooms["0"].status, "running")
            self.assertEqual(loaded.rooms["0"].teamName, "테스트팀")
            self.assertEqual(
                loaded.processed_commands["command-1"]["status"], "failed"
            )
            self.assertEqual(
                loaded.processed_commands["command-1"]["roomId"], "0"
            )
            self.assertEqual(
                loaded.processed_commands["command-1"]["errorCode"],
                "MAP_VERIFY_FAILED",
            )
            self.assertEqual(
                loaded.processed_commands["command-1"]["roomControlState"],
                "SET_INFO_FAILED",
            )
            self.assertTrue(
                loaded.processed_commands["command-1"]["ackPending"]
            )
            self.assertEqual(
                loaded.processed_commands["command-1"]["ackResolution"],
                "PENDING",
            )
            self.assertEqual(
                loaded.processed_commands["command-1"]["ackRoom"]["roomId"],
                "0",
            )
            self.assertEqual(
                loaded.processed_commands["command-1"]["traceId"],
                "CTRL-state-round-trip",
            )
            self.assertEqual(
                loaded.processed_commands["command-1"]["latencyEvents"],
                [{"stage": "VERIFY_DONE", "elapsedMs": 125}],
            )

    def test_log_patterns(self):
        rooms = {room_id: RoomState(roomId=room_id) for room_id in ("0", "1", "2", "3")}
        start = ManagerLogReader.START_RE.search(
            "2026-07-25 [INFO] [GameModule] >> A1(중) 게임 시작!!!"
        )
        score = ManagerLogReader.SCORE_RE.search(
            "2026-07-25 [INFO] [UDP] >> 점수 데이터 수신[0] score: 14 / map: level-2"
        )
        self.assertIsNotNone(start)
        self.assertEqual(start.group(1), "A1(중)")
        self.assertIsNotNone(score)
        rooms[score.group(1)].score = int(score.group(2))
        self.assertEqual(rooms["0"].score, 14)

    def test_replayed_command_is_not_executed_twice(self):
        with tempfile.TemporaryDirectory() as folder:
            command = {
                "id": "same-command",
                "roomId": "0",
                "action": "start",
                "payload": {"durationMinutes": 15},
            }
            config = BridgeConfig(simulate=True, armed=False)
            bridge = Bridge(config, Path(folder) / "state.json")
            remote = FakeRemote(command)
            bridge.remote = remote
            bridge._refresh_state = lambda: None
            bridge._automatic_stops = lambda: None
            executions = []

            def execute_once(_command):
                executions.append(_command["id"])
                return bridge.state.rooms["0"]

            bridge._execute = execute_once
            bridge.run_once()
            bridge.run_once()

            self.assertEqual(executions, ["same-command"])
            self.assertEqual([ack[1] for ack in remote.acks], ["completed", "completed"])

    def test_manual_running_game_without_remote_deadline_is_not_auto_stopped(self):
        with tempfile.TemporaryDirectory() as folder:
            config = BridgeConfig(simulate=True, armed=True)
            bridge = Bridge(config, Path(folder) / "state.json")
            room = bridge.state.rooms["0"]
            room.status = "running"
            room.remainingSeconds = 0
            room.deadline = ""

            bridge._automatic_stops()

            self.assertEqual(room.status, "running")

    def test_expired_remote_timer_waits_for_explicit_stop(self):
        with tempfile.TemporaryDirectory() as folder:
            config = BridgeConfig(simulate=False, armed=True)
            bridge = Bridge(config, Path(folder) / "state.json")
            room = bridge.state.rooms["0"]
            room.status = "running"
            room.remainingSeconds = 0
            room.deadline = "2026-01-01T00:00:00+00:00"
            stop_calls = []
            bridge.ui.stop = lambda room_id: stop_calls.append(room_id)

            bridge._automatic_stops()

            self.assertEqual(room.status, "running")
            self.assertEqual(room.deadline, "2026-01-01T00:00:00+00:00")
            self.assertEqual(stop_calls, [])

    def test_controller_remaining_time_overrides_remote_deadline(self):
        with tempfile.TemporaryDirectory() as folder:
            config = BridgeConfig(simulate=False, armed=True)
            bridge = Bridge(config, Path(folder) / "state.json")
            room = bridge.state.rooms["0"]
            room.status = "running"
            room.remainingSeconds = 900
            room.deadline = "2099-01-01T00:00:00+00:00"

            observed = RoomState(
                roomId="0",
                status="running",
                remainingSeconds=539,
            )
            bridge.ui.read_rooms = lambda: {
                "0": observed,
                "1": RoomState(roomId="1", status="waiting"),
                "2": RoomState(roomId="2", status="waiting"),
                "3": RoomState(roomId="3", status="waiting"),
            }

            bridge._refresh_state()

            self.assertEqual(bridge.state.rooms["0"].remainingSeconds, 539)
            deadline = datetime.fromisoformat(bridge.state.rooms["0"].deadline)
            seconds_left = (deadline - datetime.now(timezone.utc)).total_seconds()
            self.assertGreater(seconds_left, 535)
            self.assertLessEqual(seconds_left, 539)

    def test_healthy_idle_refresh_keeps_manager_probe_fresh(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=False, armed=True),
                Path(folder) / "state.json",
            )
            bridge.ui.read_rooms = lambda: {
                room_id: RoomState(roomId=room_id, status="waiting")
                for room_id in ("0", "1", "2", "3")
            }
            bridge.ui.has_active_modal = lambda: False
            bridge._manager_probe_at = "2000-01-01T00:00:00+00:00"
            bridge._control_recovery_successes = 0

            self.assertTrue(bridge._refresh_state())
            first_probe_at = bridge._manager_probe_at
            self.assertNotEqual(first_probe_at, "2000-01-01T00:00:00+00:00")
            self.assertEqual(bridge._control_recovery_successes, 1)

            self.assertTrue(bridge._refresh_state())
            status = bridge._control_status_snapshot()
            self.assertEqual(status["managerState"], "AVAILABLE")
            self.assertFalse(status["stateStale"])
            self.assertEqual(status["managerProbeSuccessCount"], 2)
            bridge.close()

    def test_failed_refresh_does_not_refresh_manager_probe_timestamp(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = Bridge(
                BridgeConfig(simulate=False, armed=True),
                Path(folder) / "state.json",
            )
            bridge.ui.read_rooms = lambda: (_ for _ in ()).throw(
                RuntimeError("fresh state unavailable")
            )
            bridge.ui.has_active_modal = lambda: False
            bridge.logs.apply = lambda _rooms: None
            previous_probe_at = "2026-08-19T16:48:39+09:00"
            bridge._manager_probe_at = previous_probe_at
            bridge._control_recovery_successes = 1

            self.assertFalse(bridge._refresh_state())
            status = bridge._control_status_snapshot()
            self.assertEqual(status["managerProbeAt"], previous_probe_at)
            self.assertEqual(status["managerProbeSuccessCount"], 0)
            self.assertEqual(status["managerState"], "UNAVAILABLE")
            bridge.close()

    def test_all_stop_only_changes_running_rooms(self):
        with tempfile.TemporaryDirectory() as folder:
            config = BridgeConfig(simulate=True, armed=True)
            bridge = Bridge(config, Path(folder) / "state.json")
            bridge.state.rooms["0"].status = "running"
            bridge.state.rooms["0"].remainingSeconds = 120
            bridge.state.rooms["0"].deadline = "2026-07-26T12:00:00+00:00"
            bridge.state.rooms["1"].status = "waiting"
            bridge.state.rooms["1"].score = 42

            bridge._execute({"roomId": "ALL", "action": "all_stop", "payload": {}})

            self.assertEqual(bridge.state.rooms["0"].status, "waiting")
            self.assertEqual(bridge.state.rooms["0"].deadline, "")
            self.assertEqual(bridge.state.rooms["1"].status, "waiting")
            self.assertEqual(bridge.state.rooms["1"].score, 42)

    def test_simulation_control_lock_can_be_toggled_atomically(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "server_url": "https://example.test",
                        "agent_token": "test-token",
                        "simulate": True,
                        "armed": False,
                    }
                ),
                encoding="utf-8",
            )

            enabled = set_config_armed(path, True)
            self.assertTrue(enabled["safe"])
            self.assertTrue(BridgeConfig.load(path).armed)

            disabled = set_config_armed(path, False)
            self.assertTrue(disabled["safe"])
            self.assertFalse(BridgeConfig.load(path).armed)

    def test_running_bridge_reloads_control_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            config_path = Path(folder) / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "server_url": "https://example.test",
                        "agent_token": "test-token",
                        "simulate": True,
                        "armed": True,
                    }
                ),
                encoding="utf-8",
            )
            bridge = Bridge(
                BridgeConfig.load(config_path),
                Path(folder) / "state.json",
                config_path,
            )
            bridge.remote = FakeRemote({})
            bridge._refresh_state = lambda: None
            bridge._automatic_stops = lambda: None

            set_config_armed(config_path, False)
            bridge.run_once()

            self.assertFalse(bridge.config.armed)

    def test_partial_config_save_keeps_bridge_running_with_previous_setting(self):
        with tempfile.TemporaryDirectory() as folder:
            config_path = Path(folder) / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "server_url": "https://example.test",
                        "agent_token": "test-token",
                        "simulate": True,
                        "armed": True,
                    }
                ),
                encoding="utf-8",
            )
            bridge = Bridge(
                BridgeConfig.load(config_path),
                Path(folder) / "state.json",
                config_path,
            )
            bridge.remote = FakeRemote({})
            bridge._refresh_state = lambda: None
            bridge._automatic_stops = lambda: None

            config_path.write_text('{"armed":', encoding="utf-8")
            bridge.run_once()

            self.assertTrue(bridge.config.armed)


if __name__ == "__main__":
    unittest.main()
