from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from mpos_lan.client import MposClient
from mpos_lan.config import MposConfig
from mpos_lan.gateway import GatewayResponse
from payment_service import PaymentService


def approved(work_type: str = "D6") -> GatewayResponse:
    return GatewayResponse(
        0,
        {
            "Response Code": "0000",
            "Work Type": work_type,
            "Authorization Number": "A12345",
            "Authorization Date": "20260810123456",
            "Issuer Name": "테스트카드",
            "Acquirer Name": "테스트매입",
            "Masking Financial Information": "1234********5678",
        },
        20,
    )


class FakeGateway:
    def __init__(self):
        self.pay_calls = 0
        self.cancel_calls = 0
        self.status_calls = 0
        self.pay_effect = approved()
        self.cancel_effect = approved("D7")
        self.status_effect = GatewayResponse(
            0,
            {
                "Response Code": "0000",
                "H/W Model Name": "#MPOS-1700AE",
                "F/W Version": "1201",
                "Integrity Info": "Y",
            },
            5,
        )

    @staticmethod
    def _value(effect):
        if isinstance(effect, BaseException):
            raise effect
        return effect

    def status(self, *, trace=None):
        del trace
        self.status_calls += 1
        return self._value(self.status_effect)

    def pay(self, amount, installment, *, trace=None):
        del amount, installment, trace
        self.pay_calls += 1
        return self._value(self.pay_effect)

    def cancel(self, amount, installment, auth_date, auth_no, *, trace=None):
        del amount, installment, auth_date, auth_no, trace
        self.cancel_calls += 1
        return self._value(self.cancel_effect)

    def close(self):
        return None


class BlockingGateway(FakeGateway):
    def __init__(self):
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def pay(self, amount, installment, *, trace=None):
        del amount, installment, trace
        self.pay_calls += 1
        self.entered.set()
        if not self.release.wait(3):
            raise TimeoutError("test wait")
        return self.pay_effect


class PaymentServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.config = MposConfig(
            host="127.0.0.1",
            port=4600,
            dll_path=root / "unused.dll",
            business_number="0000000000",
            status_retries=1,
            database_path=root / "payments.db",
            log_path=root / "payments.log",
        )
        self.gateway = FakeGateway()
        self.clients: list[MposClient] = []
        self.service = self._service(self.gateway)

    def _service(self, gateway: FakeGateway):
        def factory(config: MposConfig):
            client = MposClient(config, gateway=gateway)
            self.clients.append(client)
            return client

        return PaymentService(self.config, client_factory=factory)

    def tearDown(self):
        self.service.close()
        for client in self.clients:
            client.close()
        self.temp.cleanup()

    def test_start_status_and_close(self):
        self.assertTrue(self.service.terminal_snapshot()["success"])
        self.assertTrue(self.service.terminal_snapshot()["payment_ready"])
        self.assertEqual(self.gateway.status_calls, 1)
        self.service.close()
        self.assertFalse(self.service.status()["success"])
        self.assertFalse(self.service.status()["payment_ready"])

    def test_terminal_offline_does_not_crash(self):
        self.gateway.status_effect = GatewayResponse(
            -5008,
            {"ErrorInfo": "Socket Connect Error [Timeout]"},
            5,
        )
        result = self.service.status()
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "CONNECTION_FAILED")

    def test_mock_approval_and_same_uuid_replay(self):
        first = self.service.pay("ORDER-1", 1000, transaction_uuid="ORDER-1-PAY-1")
        second = self.service.pay("ORDER-1", 1000, transaction_uuid="ORDER-1-PAY-1")
        self.assertEqual(first["status"], "APPROVED")
        self.assertEqual(second["status"], "APPROVED")
        self.assertTrue(second["idempotent_replay"])
        self.assertEqual(self.gateway.pay_calls, 1)

    def test_trace_events_are_separate_from_safe_payment_result(self):
        result = self.service.execute(
            "payment_pay",
            {
                "reservationId": "reservation-1",
                "transactionUuid": "ORDER-TRACE-PAY-1",
                "amount": 1000,
                "traceId": "PAY-20260811-201500-AB12CD",
            },
        )
        events = result.pop("_latency_events")
        self.assertEqual(result["trace_id"], "PAY-20260811-201500-AB12CD")
        self.assertTrue(any(event["stage"] == "BRIDGE_REQUEST_RECEIVED" for event in events))
        self.assertTrue(any(event["stage"] == "BRIDGE_RESPONSE_START" for event in events))
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("latency_events", serialized)

    def test_decline_and_user_cancel_are_distinct(self):
        self.gateway.pay_effect = GatewayResponse(
            0,
            {"Response Code": "5973", "ErrorInfo": "거래 거절"},
            10,
        )
        declined = self.service.pay("ORDER-2", 1000, transaction_uuid="ORDER-2-PAY-1")
        self.assertEqual(declined["status"], "DECLINED")
        self.assertEqual(declined["error_code"], "DECLINED")

        self.gateway.pay_effect = GatewayResponse(-203, {"ErrorInfo": "사용자 취소"}, 10)
        cancelled = self.service.pay("ORDER-2", 1000, transaction_uuid="ORDER-2-PAY-2")
        self.assertEqual(cancelled["status"], "ERROR")
        self.assertEqual(cancelled["error_code"], "USER_CANCELLED")

    def test_timeout_unknown_is_never_resent(self):
        self.gateway.pay_effect = TimeoutError("simulated")
        first = self.service.pay("ORDER-3", 1000, transaction_uuid="ORDER-3-PAY-1")
        second = self.service.pay("ORDER-3", 1000, transaction_uuid="ORDER-3-PAY-1")
        self.assertEqual(first["status"], "UNKNOWN")
        self.assertEqual(second["status"], "UNKNOWN")
        self.assertEqual(self.gateway.pay_calls, 1)

    def test_double_click_and_concurrent_request_are_busy(self):
        self.service.close()
        gateway = BlockingGateway()
        self.service = self._service(gateway)
        results = []
        thread = threading.Thread(
            target=lambda: results.append(
                self.service.pay("ORDER-4", 1000, transaction_uuid="ORDER-4-PAY-1")
            )
        )
        thread.start()
        self.assertTrue(gateway.entered.wait(2))
        duplicate = self.service.pay(
            "ORDER-4", 1000, transaction_uuid="ORDER-4-PAY-1"
        )
        other = self.service.pay(
            "ORDER-5", 1000, transaction_uuid="ORDER-5-PAY-1"
        )
        self.assertEqual(duplicate["status"], "BUSY")
        self.assertEqual(other["status"], "BUSY")
        gateway.release.set()
        thread.join(3)
        self.assertEqual(gateway.pay_calls, 1)
        self.assertEqual(results[0]["status"], "APPROVED")

    def test_restart_recovers_same_uuid_without_dll_call(self):
        first = self.service.pay("ORDER-6", 1000, transaction_uuid="ORDER-6-PAY-1")
        self.assertEqual(first["status"], "APPROVED")
        self.service.close()
        second_gateway = FakeGateway()
        self.service = self._service(second_gateway)
        replay = self.service.pay("ORDER-6", 1000, transaction_uuid="ORDER-6-PAY-1")
        self.assertEqual(replay["status"], "APPROVED")
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(second_gateway.pay_calls, 0)

    def test_cancel_links_original_transaction_and_prevents_second_cancel(self):
        payment = self.service.pay(
            "ORDER-7", 1000, transaction_uuid="ORDER-7-PAY-1"
        )
        cancelled = self.service.cancel(
            payment["transaction_uuid"],
            amount=1000,
            auth_no=payment["auth_no"],
            auth_date=payment["auth_date"],
            transaction_uuid="ORDER-7-CANCEL-1",
            original_transaction_id=payment["mpos_transaction_id"],
        )
        replay = self.service.cancel(
            payment["transaction_uuid"],
            amount=1000,
            auth_no=payment["auth_no"],
            auth_date=payment["auth_date"],
            transaction_uuid="ORDER-7-CANCEL-2",
            original_transaction_id=payment["mpos_transaction_id"],
        )
        self.assertEqual(cancelled["status"], "CANCELLED")
        self.assertEqual(cancelled["original_transaction_id"], payment["mpos_transaction_id"])
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(self.gateway.cancel_calls, 1)

    def test_database_and_log_do_not_contain_raw_card_or_track_fields(self):
        result = self.service.pay(
            "ORDER-8", 1000, transaction_uuid="ORDER-8-PAY-1"
        )
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("track1", serialized.lower())
        self.assertNotIn("track2", serialized.lower())
        self.assertNotIn("card_number", serialized.lower())
        connection = sqlite3.connect(self.config.database_path)
        try:
            columns = [
                row[1]
                for row in connection.execute("PRAGMA table_info(transactions)")
            ]
        finally:
            connection.close()
        self.assertNotIn("track1", columns)
        self.assertNotIn("track2", columns)
        self.assertNotIn("card_number", columns)
        log_text = self.config.log_path.read_text(encoding="utf-8")
        self.assertNotIn("1234********5678", log_text)


if __name__ == "__main__":
    unittest.main()
